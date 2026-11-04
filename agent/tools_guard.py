"""Agent 工具审批策略（人工确认关卡）。

产品规则（2026-11-04 起）：

| 工具类型 | 工具 | 策略 |
|---|---|---|
| 查询 | `crm_search_*` / `crm_get_*` / `crm_*_stats` / 通用工具 | 不拦，直接执行 |
| 修改 | `crm_update_lead` / `crm_update_order` | 暂停 → 前端弹审批卡 → 批准才执行 |
| 删除 | `crm_delete_lead` / `crm_delete_order` | **不注册、入口直接拒绝**（见 `tools_crm_write.AGENT_DELETE_ENABLED`） |

实现要点：
- 审批用框架自带的 `interrupt_on`（底层 langchain `HumanInTheLoopMiddleware`），
  不自己写 `interrupt()`，避免每个工具重复一遍；
- 中断靠 checkpointer 落库，进程重启后仍可接着批；
- `description` 用工厂函数生成中文摘要，默认英文文案（"Tool execution requires
  approval"）不会出现在前端；
- 审批只是「多一道人」，工具内部的权限位与字段白名单照旧执行（批准了也不能越权）。
"""

from __future__ import annotations

from typing import Any

from crm_client import CrmCtx, mask_phone

from tools_crm_write import AGENT_DELETE_ENABLED, AUDIT_PATH, _append, _stamp

# --------------------------------------------------------------------------- #
# 文案映射
# --------------------------------------------------------------------------- #
TOOL_LABELS: dict[str, str] = {
    "crm_update_lead": "修改线索",
    "crm_update_order": "修改订单",
    "crm_delete_lead": "删除线索",
    "crm_delete_order": "删除订单",
}

FIELD_LABELS: dict[str, str] = {
    "name": "姓名",
    "phone": "电话",
    "source": "客户来源",
    "status": "状态",
    "priority": "优先级",
    "assignee": "负责人",
    "intent_product": "意向产品",
    "budget_range": "预算区间",
    "customer_position": "客户定位",
    "trial_duration": "试用时长",
    "remark": "备注",
    "amount": "金额",
}

# 这两个是「改哪条记录」的定位参数，不算被改字段
_TARGET_KEYS = ("lead_id", "order_key")

# 枚举值翻中文，避免审批卡上出现 status=won 这种
_VALUE_LABELS: dict[str, str] = {
    "high": "高",
    "medium": "中",
    "low": "低",
    "won": "成交",
    "lost": "客户流失",
}


def _pretty(key: str, value: Any) -> str:
    text = str(value)
    if key == "amount":
        try:
            return f"{float(text):,.2f} 元"
        except ValueError:
            return text
    # 审批卡会被人看到，也不该出现完整手机号
    if key == "phone":
        return mask_phone(text)
    return _VALUE_LABELS.get(text, text)


def target_of(tool_name: str, args: dict[str, Any]) -> str:
    """审批卡标题里的「改哪一条」。"""
    for key in _TARGET_KEYS:
        value = args.get(key)
        if value:
            return str(value)
    return ""


def fields_of(tool_name: str, args: dict[str, Any]) -> list[dict[str, str]]:
    """审批卡正文里的「改什么、改成什么」。"""
    rows: list[dict[str, str]] = []
    for key, value in (args or {}).items():
        if key in _TARGET_KEYS or value in ("", None):
            continue
        rows.append({"key": key, "label": FIELD_LABELS.get(key, key), "value": _pretty(key, value)})
    return rows


def summarize(tool_name: str, args: dict[str, Any]) -> str:
    """一句中文摘要，既做 `description`，也可直接当卡片兜底文案。"""
    label = TOOL_LABELS.get(tool_name, tool_name)
    target = target_of(tool_name, args)
    rows = fields_of(tool_name, args)
    changes = "；".join(f"{row['label']} → {row['value']}" for row in rows) or "（无字段变化）"
    return f"{label} {target}".strip() + f"：{changes}"


# --------------------------------------------------------------------------- #
# interrupt_on 配置
# --------------------------------------------------------------------------- #
def _describe(tool_call: dict[str, Any], _state: Any = None, _runtime: Any = None) -> str:
    """框架要求签名 `(tool_call, state, runtime)`，实际只用 tool_call。"""
    return summarize(tool_call.get("name", ""), tool_call.get("args") or {})


# 修改类工具：总是拦。只给 approve / reject —— 允许「改参数后执行」需要前端做参数表单，
# 当前交互不值得，用户想让 Agent 改成别的值，重新说一句更直观。
INTERRUPT_ON: dict[str, dict[str, Any]] = {
    "crm_update_lead": {
        "allowed_decisions": ["approve", "reject"],
        "description": _describe,
    },
    "crm_update_order": {
        "allowed_decisions": ["approve", "reject"],
        "description": _describe,
    },
}

# 删除类工具：配置留档，但因为不注册给模型，实际不会触发中断
BLOCKED_DELETE_TOOLS = {
    "crm_delete_lead": "删除线索",
    "crm_delete_order": "删除订单",
}
assert AGENT_DELETE_ENABLED is False, "删除工具当前必须保持关闭"


def build_interrupt_on(approval_tools: set[str] | None = None) -> dict[str, dict[str, Any]]:
    """返回可直接传给 `create_deep_agent(interrupt_on=...)` 的配置。

    `approval_tools` 来自「Agent 控制面板」里权限=人工审批 的工具集合；
    不传则退回硬编码的 `INTERRUPT_ON`（老行为，测试与脚本仍在用）。
    """
    names = set(INTERRUPT_ON) if approval_tools is None else set(approval_tools)
    return {
        name: {
            "allowed_decisions": ["approve", "reject"],
            "description": _describe,
        }
        for name in sorted(names)
    }


def needs_review(tool_name: str) -> bool:
    return tool_name in INTERRUPT_ON


# --------------------------------------------------------------------------- #
# 中断值 → 前端事件
# --------------------------------------------------------------------------- #
def build_approval_event(interrupt_value: Any, thread_id: str, interrupt_id: str = "") -> dict[str, Any]:
    """把 HITL 中间件的 `{action_requests, review_configs}` 变成前端能直接渲染的事件。

    `batched` 模式下所有被拦的调用在一个中断里，decisions 必须**按下标**回传，
    所以这里显式给出 index，前端不要按工具名匹配。
    """
    value = interrupt_value if isinstance(interrupt_value, dict) else {}
    requests = value.get("action_requests") or []
    configs = value.get("review_configs") or []

    actions: list[dict[str, Any]] = []
    for index, request in enumerate(requests):
        if not isinstance(request, dict):
            continue
        name = str(request.get("name") or "")
        args = request.get("args") or {}
        review = configs[index] if index < len(configs) and isinstance(configs[index], dict) else {}
        actions.append(
            {
                "index": index,
                "tool": name,
                "label": TOOL_LABELS.get(name, name),
                "target": target_of(name, args),
                "summary": summarize(name, args),
                "fields": fields_of(name, args),
                "args": args,
                "allowed_decisions": review.get("allowed_decisions") or ["approve", "reject"],
            }
        )

    return {
        "type": "approval_required",
        "thread_id": thread_id,
        "interrupt_id": interrupt_id,
        "actions": actions,
        "mode": "batched",
    }


# --------------------------------------------------------------------------- #
# 审批留痕
# --------------------------------------------------------------------------- #
def record_decisions(
    ctx: CrmCtx | None,
    thread_id: str,
    actions: list[dict[str, Any]],
    decisions: list[dict[str, Any]],
) -> None:
    """把「谁批的、批了什么」写进 audit.jsonl，与工具自身的写操作记录并列。"""
    for index, decision in enumerate(decisions):
        action = actions[index] if index < len(actions) else {}
        _append(
            AUDIT_PATH,
            {
                "ts": _stamp(),
                "uid": getattr(ctx, "uid", ""),
                "name": getattr(ctx, "name", ""),
                "role": getattr(ctx, "role_name", ""),
                "tool": action.get("tool", ""),
                "action": "approval",
                "target": action.get("target", ""),
                "changes": action.get("fields") or [],
                "ok": decision.get("type") == "approve",
                "error": "" if decision.get("type") == "approve" else str(decision.get("type")),
                "decision": decision.get("type", ""),
                "reason": decision.get("message", ""),
                "thread_id": thread_id,
            },
        )


# 会话处于「等人批」状态时，用户继续发消息要给出可执行的提示
PENDING_MESSAGE = "这个会话还有一条修改操作在等待你确认，请先在上面的审批卡里点「批准」或「拒绝」。"


def describe_actions(actions: list[dict[str, Any]]) -> str:
    return "；".join(str(item.get("summary") or item.get("tool") or "") for item in actions)
