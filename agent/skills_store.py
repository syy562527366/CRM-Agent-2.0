"""Skill（技能）目录管理：发现 / 校验 / 后端路由。

DeepAgents 的 Skill 是「渐进式披露」机制，不是把整篇说明书塞进提示词：

1. 每轮开始只把技能的 `name` + `description` 注入系统提示词（几十字，几乎不占 token）；
2. 模型判断这次请求需要某个技能时，自己用 `read_file` 读该技能的 `SKILL.md` 拿完整步骤；
3. 技能目录里的模板 / 参考资料 / 脚本，模型再用 `ls` / `read_file` 按需取。

存放约定：

    agent/skills/<技能名>/SKILL.md      必需：YAML frontmatter + Markdown 正文
    agent/skills/<技能名>/<任意附件>     可选：模板、示例、参考资料

`SKILL.md` 的 frontmatter 至少要有 `name` 与 `description`：

    ---
    name: weekly-report
    description: 按固定结构生成销售周报，用户说「出周报」时使用。
    ---

`name` 必须与所在目录名完全一致，只允许小写字母、数字和连字符（1-64 字符）。

为什么技能放在 `agent/skills/` 而不是每个账号的工作目录里：
技能是产品资产，所有账号共用同一份、跟着 git 版本走；工作目录是用户自己的草稿区。
所以 `build_backend()` 用 `CompositeBackend` 把 `/skills/` 路由到共享目录，
其余路径仍然落在各自账号的 `workspace/<uid>/`，互不可见。
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path
from typing import Any

import yaml
from deepagents.backends import CompositeBackend, FilesystemBackend

_AGENT_DIR = Path(__file__).resolve().parent

# 技能根目录：默认 agent/skills/，可用 AGENT_SKILLS_DIR 覆盖（测试或换盘时用）
SKILLS_DIR = Path(os.getenv("AGENT_SKILLS_DIR") or (_AGENT_DIR / "skills"))

# 已关闭的技能放在这里。为什么是「移出目录」而不是加个 enabled 字段：
# 框架的 SkillsMiddleware 只扫来源目录的**顶层子目录**（ls 一遍，有 SKILL.md 就加载），
# 没有任何过滤参数；把目录留在原地等于仍然会注入提示词、仍然能被 read_file 读到。
# 移到同级目录后，`ls /skills/` 看不到它，`read_file /skills/<name>/SKILL.md` 也会失败，
# 是真正意义上的「不可用」，而不是「提示词里劝模型别用」。
DISABLED_DIR = Path(
    os.getenv("AGENT_SKILLS_DISABLED_DIR") or (_AGENT_DIR / "skills-disabled")
)

# 模型看到的虚拟路径前缀。CompositeBackend 会把 /skills/xxx 映射到 SKILLS_DIR/xxx
SKILLS_ROUTE = "/skills/"

# Agent Skills 规范的技能名约束
_NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
NAME_MAX_LEN = 64
DESCRIPTION_MAX_LEN = 1024


class SkillError(Exception):
    """技能操作失败（名称非法 / 不存在 / 校验不通过），message 直接给前端展示。"""


def ensure_dir() -> Path:
    """技能目录不存在就建一个（空目录时 Agent 仍能正常工作）。"""
    SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    return SKILLS_DIR


def ensure_disabled_dir() -> Path:
    DISABLED_DIR.mkdir(parents=True, exist_ok=True)
    return DISABLED_DIR


def resolve_dir(name: str) -> tuple[Path, bool]:
    """按名字找技能目录，返回 (目录, 是否启用)。找不到抛 SkillError。

    名称先过一遍白名单再拼路径：接口参数直接进文件系统，不校验就能 `../` 穿越。
    """
    if not _NAME_RE.match(name or ""):
        raise SkillError(f"非法的技能名：{name!r}（只允许小写字母、数字和连字符）")
    for base, enabled in ((SKILLS_DIR, True), (DISABLED_DIR, False)):
        candidate = base / name
        if candidate.is_dir():
            return candidate, enabled
    raise SkillError(f"技能不存在：{name}")



def _read_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    """解析 SKILL.md 的 YAML frontmatter，返回 (元数据, 正文)。

    解析失败不抛异常：坏文件由 `list_skills()` 标成 invalid，
    这样一处写错不会把整个 Agent 带崩。
    """
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return {}, ""

    if not text.startswith("---"):
        return {}, text

    # 只按前两个分隔符切：正文里出现 --- 也不会被误判
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text

    try:
        meta = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError:
        return {}, text
    if not isinstance(meta, dict):
        return {}, text
    return meta, parts[2].lstrip("\n")


def _as_list(value: Any) -> list[str]:
    """frontmatter 里的字段可能是空格分隔的字符串，也可能是 YAML 列表。"""
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, str):
        return [item for item in value.split() if item]
    return []


def _validate(name: str, dir_name: str, description: str, has_frontmatter: bool) -> list[str]:
    errors: list[str] = []
    if not has_frontmatter:
        errors.append("SKILL.md 缺少 YAML frontmatter（文件需以 --- 开头）")
        return errors
    if not name:
        errors.append("frontmatter 缺少 name")
    else:
        if not _NAME_RE.match(name):
            errors.append("name 只能包含小写字母、数字和连字符，且不能以连字符开头/结尾或出现连续连字符")
        if len(name) > NAME_MAX_LEN:
            errors.append(f"name 超过 {NAME_MAX_LEN} 个字符")
        if name != dir_name:
            errors.append(f"name（{name}）必须与目录名（{dir_name}）一致")
    if not description:
        errors.append("frontmatter 缺少 description")
    elif len(description) > DESCRIPTION_MAX_LEN:
        errors.append(f"description 超过 {DESCRIPTION_MAX_LEN} 个字符")
    return errors


def _skill_files(dir_path: Path) -> list[str]:
    """列出技能目录内的相对路径（不含 SKILL.md），供前端展示「这个技能带了什么」。"""
    files: list[str] = []
    for item in sorted(dir_path.rglob("*")):
        if item.is_file() and item.name != "SKILL.md":
            files.append(item.relative_to(dir_path).as_posix())
    return files


def _entry(dir_path: Path, enabled: bool) -> dict[str, Any]:
    """把一个技能目录读成前端要的条目（含不合规的，valid=False 并带 errors）。"""
    skill_file = dir_path / "SKILL.md"
    if not skill_file.is_file():
        return {
            "name": dir_path.name,
            "dir": dir_path.name,
            "description": "",
            "path": "",
            "files": _skill_files(dir_path),
            "enabled": enabled,
            "valid": False,
            "errors": ["目录里没有 SKILL.md"],
        }

    meta, _body = _read_frontmatter(skill_file)
    name = str(meta.get("name") or "").strip()
    description = " ".join(str(meta.get("description") or "").split())
    errors = _validate(name, dir_path.name, description, bool(meta))

    metadata = meta.get("metadata") if isinstance(meta.get("metadata"), dict) else {}
    return {
        "name": name or dir_path.name,
        "dir": dir_path.name,
        "description": description,
        "path": f"{SKILLS_ROUTE}{dir_path.name}/SKILL.md",
        "files": _skill_files(dir_path),
        "allowed_tools": _as_list(meta.get("allowed-tools") or meta.get("allowed_tools")),
        "include_tools": _as_list(metadata.get("include_tools")),
        "license": str(meta.get("license") or ""),
        "enabled": enabled,
        "valid": not errors,
        "errors": errors,
    }


def list_skills() -> list[dict[str, Any]]:
    """扫描启用 / 关闭两个目录，返回全部技能。

    不合规的技能不会被 `names()` 选中，也就不会被传给 Agent ——
    校验失败的文件只会出现在控制面板里等人修，不会污染模型上下文。
    """
    ensure_dir()
    ensure_disabled_dir()
    out: list[dict[str, Any]] = []

    for base, enabled in ((SKILLS_DIR, True), (DISABLED_DIR, False)):
        for dir_path in sorted(base.iterdir(), key=lambda p: p.name.lower()):
            if not dir_path.is_dir() or dir_path.name.startswith((".", "_")):
                continue
            out.append(_entry(dir_path, enabled))

    # 启用的排在前面，其余按名称
    out.sort(key=lambda item: (not item["enabled"], item["dir"].lower()))
    return out


def names() -> list[str]:
    """可用的技能名（通过校验 + 已启用），直接喂给 create_deep_agent 的 skills 参数。"""
    return [item["name"] for item in list_skills() if item["valid"] and item["enabled"]]


def read_skill(name: str) -> dict[str, Any]:
    """读一篇 SKILL.md 的原文，供编辑弹窗使用。"""
    dir_path, enabled = resolve_dir(name)
    skill_file = dir_path / "SKILL.md"
    if not skill_file.is_file():
        raise SkillError(f"`{name}` 目录里没有 SKILL.md")
    entry = _entry(dir_path, enabled)
    entry["content"] = skill_file.read_text(encoding="utf-8-sig")
    return entry


def save_skill(name: str, content: str) -> dict[str, Any]:
    """覆写 SKILL.md，写盘前先按同一套规则校验。

    校验不过不落盘 —— 否则控制面板里改错一个缩进，整个技能就变 invalid，
    模型下一轮直接丢掉它，而且现场已经被覆盖了。
    """
    dir_path, enabled = resolve_dir(name)
    text = (content or "").replace("\r\n", "\n")
    if not text.strip():
        raise SkillError("内容不能为空")

    # 用临时文件 + 原子替换：避免写到一半进程被杀，留下半篇 SKILL.md
    tmp = dir_path / ".SKILL.md.tmp"
    tmp.write_text(text, encoding="utf-8")

    meta, body = _read_frontmatter(tmp)
    frontmatter_ok = bool(meta)
    description = " ".join(str(meta.get("description") or "").split())
    errors = _validate(str(meta.get("name") or "").strip(), dir_path.name, description, frontmatter_ok)
    if not body.strip():
        errors.append("正文为空（frontmatter 之后没有任何内容）")
    if errors:
        tmp.unlink(missing_ok=True)
        raise SkillError("；".join(errors))

    os.replace(tmp, dir_path / "SKILL.md")
    return _entry(dir_path, enabled)


def set_enabled(name: str, enabled: bool) -> dict[str, Any]:
    """启用 / 关闭技能：在 skills/ 与 skills-disabled/ 之间移动目录。

    移动而不是复制：同一份文件只存在一处，不会出现「两个版本谁是准的」。
    """
    dir_path, current = resolve_dir(name)
    if current == enabled:
        return _entry(dir_path, enabled)

    target_base = SKILLS_DIR if enabled else DISABLED_DIR
    target_base.mkdir(parents=True, exist_ok=True)
    target = target_base / dir_path.name
    if target.exists():
        raise SkillError(f"目标目录已存在同名技能：{target}")
    shutil.move(str(dir_path), str(target))
    return _entry(target, enabled)


def build_backend(workspace_root: Path) -> CompositeBackend:
    """构建「按账号隔离的工作目录 + 全局共享的技能目录」复合后端。

    - `/skills/`            → agent/skills/（所有账号读同一份，只读用途）
    - 其余所有路径           → agent/workspace/<uid>/（virtual_mode 挡住 ../ 穿越）
    """
    ensure_dir()
    return CompositeBackend(
        default=FilesystemBackend(root_dir=str(workspace_root), virtual_mode=True),
        routes={
            SKILLS_ROUTE: FilesystemBackend(root_dir=str(SKILLS_DIR), virtual_mode=True),
        },
    )


def summary() -> dict[str, Any]:
    """给 /health、/skills 与「Skill 管理」页签用的概览。"""
    items = list_skills()
    valid = [item for item in items if item["valid"]]
    active = [item for item in items if item["valid"] and item["enabled"]]
    return {
        "root": str(SKILLS_DIR),
        "disabled_root": str(DISABLED_DIR),
        "route": SKILLS_ROUTE,
        "total": len(items),
        "valid": len(valid),
        "enabled": len(active),
        "disabled": len(items) - len(active),
        "invalid": len(items) - len(valid),
        "names": [item["name"] for item in active],
        "skills": items,
    }
