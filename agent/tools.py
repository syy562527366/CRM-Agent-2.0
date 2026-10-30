"""Agent 可调用的基础工具集。

deepagents 的 deep agent 默认已具备 todo / filesystem / subagent 能力，
这里补充两个业务上最常用的轻量工具，用于验证「工具调用」链路。
"""

from __future__ import annotations

import ast
import operator
from datetime import datetime
from zoneinfo import ZoneInfo

from langchain_core.tools import tool

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


TOOLS = [calculator, get_current_time]
