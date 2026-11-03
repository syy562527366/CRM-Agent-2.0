"""Agent 可调用的基础工具集。

deepagents 的 deep agent 默认已具备 todo / filesystem / subagent 能力，
这里补充业务上最常用的轻量工具：计算、时间、CRM 线索查询。
"""

from __future__ import annotations

import ast
import json
import operator
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from langchain_core.tools import tool

# CRM 线索数据文件（与本仓库前端共用 data/leads.json）
LEADS_PATH = Path(__file__).resolve().parent.parent / "data" / "leads.json"

# 对外暴露的字段（去掉身份证等敏感信息）
_LEAD_FIELDS = (
    "id",
    "name",
    "status",
    "priority",
    "source",
    "assignee",
    "intentProduct",
    "budgetRange",
    "communicationCount",
    "lastFollowUpAt",
    "remark",
    "customerPosition",
    "trialDuration",
)

_BIN_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY_OPS = {ast.UAdd: operator.pos, ast.USub: operator.neg}


def _eval_node(node: ast.AST) -> float:
    """只允许四则运算 / 乘方 / 括号，杜绝 eval 的任意代码执行。"""
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float)):
            return node.value
        raise ValueError(f"不支持的常量类型: {type(node.value).__name__}")
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN_OPS:
        return _BIN_OPS[type(node.op)](_eval_node(node.left), _eval_node(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPS:
        return _UNARY_OPS[type(node.op)](_eval_node(node.operand))
    raise ValueError(f"不支持的表达式节点: {type(node).__name__}")


@tool
def calculator(expression: str) -> str:
    """计算一个数学表达式，支持 + - * / // % ** 和括号。

    Args:
        expression: 例如 "(128*37+56)/4"。
    """
    try:
        result = _eval_node(ast.parse(expression, mode="eval").body)
    except Exception as exc:  # noqa: BLE001 - 工具层需要把任何错误转成文本返回给模型
        return f"计算失败：{exc}"
    return f"{expression} = {result}"


@tool
def get_current_time(timezone: str = "Asia/Shanghai") -> str:
    """获取指定时区的当前时间，默认 Asia/Shanghai。

    Args:
        timezone: IANA 时区名，例如 "Asia/Shanghai"、"UTC"。
    """
    try:
        now = datetime.now(ZoneInfo(timezone))
    except Exception:  # noqa: BLE001 - 非法时区回退到本地时间
        now = datetime.now()
        timezone = "local"
    return f"{now.strftime('%Y-%m-%d %H:%M:%S')} ({timezone})"


@tool
def crm_read_leads(status: str = "", priority: str = "", keyword: str = "", limit: int = 5) -> str:
    """查询 CRM 线索（客户）数据，返回 JSON 数组。

    Args:
        status: 按状态筛选，例如 "成交"、"客户流失"、"跟进中"；留空表示不限。
        priority: 按意向等级筛选：high / medium / low；留空表示不限。
        keyword: 按客户姓名或线索编号模糊匹配；留空表示不限。
        limit: 最多返回的条数，默认 5，最大 20。
    """
    try:
        raw = json.loads(LEADS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return f"线索数据文件不存在：{LEADS_PATH}"
    except json.JSONDecodeError as exc:
        return f"线索数据解析失败：{exc}"

    rows = raw if isinstance(raw, list) else raw.get("leads", [])
    items: list[dict] = []
    for row in rows:
        if status and status not in str(row.get("status", "")):
            continue
        if priority and str(row.get("priority", "")).lower() != priority.lower():
            continue
        if keyword and keyword not in str(row.get("name", "")) and keyword not in str(row.get("id", "")):
            continue
        items.append({k: row.get(k) for k in _LEAD_FIELDS if k in row})

    total = len(items)
    items = items[: max(1, min(int(limit or 5), 20))]
    return json.dumps({"total": total, "count": len(items), "leads": items}, ensure_ascii=False)


TOOLS = [calculator, get_current_time, crm_read_leads]
