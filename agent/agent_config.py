"""Agent 运行配置：系统提示词 + 工具开关 + 工具权限。

一份配置存在 `agent/data/agent_config.json`，三个作用点：

| 配置项 | 作用 |
|---|---|
| 系统提示词 | 覆盖 `prompts.SYSTEM_PROMPT`，下次构建 agent 生效 |
| 工具开关 | 关掉的工具**不注册给模型**（模型根本看不到） |
| 工具权限 | 直接使用 / 人工审批（`interrupt_on`）/ 禁止（同关闭） |

设计约定：

1. **白名单优先**：注册表（`REGISTRY`）里没有的工具名一律忽略，
   配置文件被手改塞进未知工具也不会影响运行；
2. **删除类工具锁死**：`crm_delete_*` 的 `locked=True`，无论配置怎么写都强制
   `enabled=False / permission=forbidden`，与 `tools_crm_write.AGENT_DELETE_ENABLED`
   的双重拦截保持一致；
3. **权限不能靠前端**：读配置与写配置的接口都要求管理员身份（`can_manage`），
   前端隐藏入口只是体验，不是安全边界；
4. 写入是**原子替换**（临时文件 + `os.replace`），避免半截 JSON 把 Agent 打挂。
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from crm_client import CrmCtx
from prompts import SYSTEM_PROMPT as DEFAULT_PROMPT

CONFIG_PATH = Path(
    os.getenv(
        "AGENT_CONFIG_PATH",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "agent_config.json"),
    )
)

# 权限三态
PERMISSIONS = ("direct", "approval", "forbidden")
PERMISSION_LABELS = {
    "direct": "直接使用",
    "approval": "人工审批",
    "forbidden": "禁止",
}
CATEGORY_LABELS = {
    "system": "通用",
    "query": "查询",
    "write": "修改",
    "delete": "删除",
}

PROMPT_MIN_LEN = 20
PROMPT_MAX_LEN = 20000

# --------------------------------------------------------------------------- #
# 工具注册表：模型能看到的全部工具（含被封禁的删除类）
# --------------------------------------------------------------------------- #
# default_permission 是首次运行（没有配置文件）时的取值，
# 修改类默认「人工审批」，删除类默认「禁止」——与产品规则一致。
REGISTRY: dict[str, dict[str, Any]] = {
    "calculator": {
        "label": "计算器",
        "category": "system",
        "permission": "direct",
        "summary": "四则运算与百分比，避免模型自己算错数",
    },
    "get_current_time": {
        "label": "时间查询",
        "category": "system",
        "permission": "direct",
        "summary": "按指定时区取当前时间",
    },
    "kb_search": {
        "label": "知识库检索",
        "category": "query",
        "permission": "direct",
        "summary": "在本地知识库检索产品服务 FAQ、技能说明、项目文档",
    },
    "crm_search_leads": {
        "label": "查询线索",
        "category": "query",
        "permission": "direct",
        "summary": "按姓名 / 电话 / 状态 / 负责人筛选线索列表",
    },
    "crm_get_lead": {
        "label": "线索详情",
        "category": "query",
        "permission": "direct",
        "summary": "单条线索的完整字段（手机号已脱敏）",
    },
    "crm_get_lead_timeline": {
        "label": "沟通记录",
        "category": "query",
        "permission": "direct",
        "summary": "某条线索最近的沟通记录",
    },
    "crm_search_orders": {
        "label": "查询订单",
        "category": "query",
        "permission": "direct",
        "summary": "订单列表与金额合计",
    },
    "crm_list_products": {
        "label": "商品列表",
        "category": "query",
        "permission": "direct",
        "summary": "在售商品与单价",
    },
    "crm_lead_stats": {
        "label": "线索统计",
        "category": "query",
        "permission": "direct",
        "summary": "按状态 / 来源 / 负责人分组计数",
    },
    "crm_sales_stats": {
        "label": "销售统计",
        "category": "query",
        "permission": "direct",
        "summary": "成交额、订单数、客单价",
    },
    "crm_update_lead": {
        "label": "修改线索",
        "category": "write",
        "permission": "approval",
        "summary": "改姓名 / 电话 / 状态 / 优先级 / 负责人等字段",
    },
    "crm_update_order": {
        "label": "修改订单",
        "category": "write",
        "permission": "approval",
        "summary": "调整订单金额（正数校验，变动过大给警告）",
    },
    "crm_delete_lead": {
        "label": "删除线索",
        "category": "delete",
        "permission": "forbidden",
        "summary": "删除线索并留底 trash.jsonl",
        "locked": True,
    },
    "crm_delete_order": {
        "label": "删除订单",
        "category": "delete",
        "permission": "forbidden",
        "summary": "删除订单并留底 trash.jsonl",
        "locked": True,
    },
}

_LOCK_REASON = "产品规则：Agent 不提供删除能力，只能由人工在列表页操作"


class ConfigError(ValueError):
    """配置非法。接口层翻译成 400，把 message 原样给前端。"""


_lock = threading.Lock()
# 按 (mtime, size) 缓存解析结果，避免每个请求都读盘
_cache: dict[str, Any] = {"key": None, "value": None}


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _defaults() -> dict[str, Any]:
    return {
        name: {
            "enabled": not meta.get("locked", False) and meta["permission"] != "forbidden",
            "permission": meta["permission"],
        }
        for name, meta in REGISTRY.items()
    }


def _read_raw() -> dict[str, Any]:
    """读盘（带 mtime 缓存）。文件损坏时退回默认值并保留原始错误，供接口提示。"""
    try:
        stat = CONFIG_PATH.stat()
    except FileNotFoundError:
        return {}

    key = f"{stat.st_mtime_ns}:{stat.st_size}"
    if _cache["key"] == key:
        return _cache["value"] or {}

    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        value = raw if isinstance(raw, dict) else {}
    except (json.JSONDecodeError, OSError):
        value = {}

    _cache["key"] = key
    _cache["value"] = value
    return value


def _normalize(raw: dict[str, Any]) -> dict[str, Any]:
    """把任意输入（含手改坏的配置）收敛成合法结构。"""
    saved_tools = raw.get("tools") if isinstance(raw.get("tools"), dict) else {}
    tools: dict[str, dict[str, Any]] = {}

    for name, meta in REGISTRY.items():
        saved = saved_tools.get(name) if isinstance(saved_tools.get(name), dict) else {}
        permission = str(saved.get("permission") or meta["permission"])
        if permission not in PERMISSIONS:
            permission = meta["permission"]

        enabled = bool(saved.get("enabled", meta["permission"] != "forbidden"))
        if permission == "forbidden":
            enabled = False
        if meta.get("locked"):
            # 锁死项永远不可开启，不管文件里写了什么
            enabled, permission = False, "forbidden"

        tools[name] = {"enabled": enabled, "permission": permission}

    prompt = raw.get("system_prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        prompt = DEFAULT_PROMPT

    return {
        "system_prompt": prompt,
        "tools": tools,
        "updated_at": str(raw.get("updated_at") or ""),
        "updated_by": str(raw.get("updated_by") or ""),
        "revision": _revision_of(prompt, tools),
    }


def _revision_of(prompt: str, tools: dict[str, Any]) -> str:
    """配置指纹：agent 实例按它缓存，改配置就换实例。"""
    payload = json.dumps({"p": prompt, "t": tools}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:12]


# --------------------------------------------------------------------------- #
# 读
# --------------------------------------------------------------------------- #
def load() -> dict[str, Any]:
    return _normalize(_read_raw())


def current_prompt() -> str:
    return load()["system_prompt"]


def revision() -> str:
    """给 agent 缓存用的版本号。没配置文件时是默认配置的指纹。"""
    return load()["revision"]


def effective_tool_names() -> set[str]:
    """真正注册给模型的工具：开着、且不是「禁止」。"""
    return {
        name
        for name, item in load()["tools"].items()
        if item["enabled"] and item["permission"] != "forbidden"
    }


def approval_tool_names() -> set[str]:
    """需要人工审批的工具（会进 interrupt_on）。"""
    return {
        name
        for name, item in load()["tools"].items()
        if item["enabled"] and item["permission"] == "approval"
    }


def view() -> dict[str, Any]:
    """GET /config 的返回体，前端可直接渲染。"""
    cfg = load()
    rows: list[dict[str, Any]] = []
    for name, meta in REGISTRY.items():
        item = cfg["tools"][name]
        locked = bool(meta.get("locked"))
        rows.append(
            {
                "name": name,
                "label": meta["label"],
                "category": meta["category"],
                "category_label": CATEGORY_LABELS.get(meta["category"], meta["category"]),
                "summary": meta["summary"],
                "enabled": item["enabled"],
                "permission": item["permission"],
                "permission_label": PERMISSION_LABELS[item["permission"]],
                "locked": locked,
                "lock_reason": _LOCK_REASON if locked else "",
            }
        )

    enabled = [row for row in rows if row["enabled"] and row["permission"] != "forbidden"]
    return {
        "system_prompt": cfg["system_prompt"],
        "default_prompt": DEFAULT_PROMPT,
        "is_default_prompt": cfg["system_prompt"].strip() == DEFAULT_PROMPT.strip(),
        "prompt_length": len(cfg["system_prompt"]),
        "tools": rows,
        "stats": {
            "total": len(rows),
            "enabled": len(enabled),
            "approval": len([r for r in enabled if r["permission"] == "approval"]),
            "direct": len([r for r in enabled if r["permission"] == "direct"]),
            "forbidden": len([r for r in rows if r["permission"] == "forbidden" or not r["enabled"]]),
        },
        "revision": cfg["revision"],
        "updated_at": cfg["updated_at"],
        "updated_by": cfg["updated_by"],
        "permission_options": [
            {"value": value, "label": PERMISSION_LABELS[value]} for value in PERMISSIONS
        ],
    }


# --------------------------------------------------------------------------- #
# 写
# --------------------------------------------------------------------------- #
def _validate_prompt(prompt: str) -> str:
    text = (prompt or "").replace("\r\n", "\n")
    if len(text.strip()) < PROMPT_MIN_LEN:
        raise ConfigError(f"系统提示词太短了，至少要 {PROMPT_MIN_LEN} 个字符")
    if len(text) > PROMPT_MAX_LEN:
        raise ConfigError(f"系统提示词太长了，最多 {PROMPT_MAX_LEN} 个字符")
    return text


def _validate_tools(patch: dict[str, Any], base: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """只改传进来的工具，其余保持原值；未知工具直接报错而不是静默丢弃。"""
    tools = {name: dict(item) for name, item in base.items()}
    for name, change in patch.items():
        meta = REGISTRY.get(name)
        if meta is None:
            raise ConfigError(f"未知工具：{name}")
        if not isinstance(change, dict):
            raise ConfigError(f"工具 {name} 的配置格式不对")

        if meta.get("locked"):
            wanted_on = bool(change.get("enabled", False))
            wanted_perm = str(change.get("permission") or tools[name]["permission"])
            if wanted_on or wanted_perm != "forbidden":
                raise ConfigError(f"{meta['label']}不允许开启：{_LOCK_REASON}")

        item = tools[name]
        if "permission" in change:
            permission = str(change["permission"])
            if permission not in PERMISSIONS:
                raise ConfigError(f"权限取值只能是 {'/'.join(PERMISSIONS)}")
            item["permission"] = permission
            if permission == "forbidden":
                item["enabled"] = False
        if "enabled" in change:
            enabled = bool(change["enabled"])
            if enabled and item["permission"] == "forbidden":
                # 重新启用时把「禁止」还原成该工具类别的默认权限，
                # 否则会出现「开关是开的但其实没注册」的怪状态
                item["permission"] = meta["permission"]
            item["enabled"] = enabled
        if item["permission"] == "forbidden":
            item["enabled"] = False
    return tools


def save(
    *,
    system_prompt: str | None = None,
    tools: dict[str, Any] | None = None,
    updated_by: str = "",
) -> dict[str, Any]:
    """部分更新并落盘，返回最新视图。"""
    with _lock:
        current = load()
        prompt = (
            current["system_prompt"] if system_prompt is None else _validate_prompt(system_prompt)
        )
        merged = (
            current["tools"] if not tools else _validate_tools(tools, current["tools"])
        )

        payload = {
            "system_prompt": prompt,
            "tools": merged,
            "updated_at": _now(),
            "updated_by": updated_by,
        }

        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(CONFIG_PATH.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, CONFIG_PATH)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

        _cache["key"] = None  # 强制下次读盘
    return view()


def reset(updated_by: str = "") -> dict[str, Any]:
    """恢复出厂：默认提示词 + 注册表默认权限。"""
    with _lock:
        payload = {
            "system_prompt": DEFAULT_PROMPT,
            "tools": _defaults(),
            "updated_at": _now(),
            "updated_by": updated_by,
        }
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        _cache["key"] = None
    return view()


# --------------------------------------------------------------------------- #
# 权限门禁
# --------------------------------------------------------------------------- #
def can_manage(ctx: CrmCtx | None) -> bool:
    """控制面板只对系统管理员开放。

    判据用「账号管理 → 修改」这一功能位：它只出现在管理员角色里，
    比按角色名匹配稳（角色名是用户可以随便改的文本）。
    """
    if ctx is None or ctx.is_anonymous:
        return False
    return ctx.can("accounts", "修改")


def tool_titles(names: Iterable[str]) -> list[str]:
    return [REGISTRY[n]["label"] for n in names if n in REGISTRY]
