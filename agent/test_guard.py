"""审批机制自测（不调用真实模型、不写 CRM）。

覆盖：
1. 工具注册表：修改工具在、删除工具不在；
2. 审批策略：只有修改类需要审，且只允许 approve / reject；
3. 中文摘要：字段翻中文、手机号脱敏、金额带千分位；
4. 中断事件结构：index / label / fields 与前端约定一致；
5. 真实 HITL 链路：批准 → 工具真的执行；拒绝 → 不执行。

    agent/.venv/Scripts/python.exe agent/test_guard.py
"""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "agent"))

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel  # noqa: E402
from langchain_core.messages import AIMessage, HumanMessage  # noqa: E402
from langchain_core.tools import tool  # noqa: E402
from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402
from langgraph.types import Command  # noqa: E402

import app  # noqa: E402
import tools_guard as guard  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    results.append((name, passed, detail))
    print(f"{'PASS' if passed else 'FAIL'} | {name} | {detail}")


# --------------------------------------------------------------------------- #
# 1. 注册表与策略
# --------------------------------------------------------------------------- #
def test_registry() -> None:
    names = {tool_.name for tool_ in app.TOOLS}
    check("注册表 · 包含修改工具", {"crm_update_lead", "crm_update_order"} <= names, ",".join(sorted(names & {"crm_update_lead", "crm_update_order"})))
    check("注册表 · 不含删除工具", not ({"crm_delete_lead", "crm_delete_order"} & names), f"共 {len(names)} 个工具")
    check("注册表 · 只读工具未受影响", {"crm_search_leads", "crm_get_lead", "crm_lead_stats"} <= names, "查询类全在")

    check("策略 · 只有修改工具需要审批", set(guard.INTERRUPT_ON) == {"crm_update_lead", "crm_update_order"}, str(list(guard.INTERRUPT_ON)))
    decisions = {tuple(cfg["allowed_decisions"]) for cfg in guard.INTERRUPT_ON.values()}
    check("策略 · 只允许批准 / 拒绝", decisions == {("approve", "reject")}, str(decisions))
    check("策略 · 查询工具不在审批表", not guard.needs_review("crm_search_leads"), "needs_review=False")
    check("策略 · 删除工具不在审批表", not guard.needs_review("crm_delete_lead"), "删除靠不注册 + FORBIDDEN 拦")


# --------------------------------------------------------------------------- #
# 2. 摘要与事件结构
# --------------------------------------------------------------------------- #
def test_summary() -> None:
    text = guard.summarize(
        "crm_update_lead",
        {"lead_id": "LD-2026-0003", "status": "成交", "priority": "high", "phone": "13912345678"},
    )
    check(
        "摘要 · 中文 + 枚举翻译 + 电话脱敏",
        "修改线索 LD-2026-0003" in text and "状态 → 成交" in text and "高" in text and "139****5678" in text,
        text,
    )
    order = guard.summarize("crm_update_order", {"order_key": "OD-2026-0001", "amount": 12800})
    check("摘要 · 金额带千分位", "12,800.00 元" in order, order)

    event = guard.build_approval_event(
        {
            "action_requests": [
                {"name": "crm_update_lead", "args": {"lead_id": "LD-1", "status": "成交"}},
                {"name": "crm_update_lead", "args": {"lead_id": "LD-2", "remark": "改备注"}},
            ],
            "review_configs": [
                {"action_name": "crm_update_lead", "allowed_decisions": ["approve", "reject"]},
                {"action_name": "crm_update_lead", "allowed_decisions": ["approve", "reject"]},
            ],
        },
        "s-1",
        "int-1",
    )
    check("事件 · 类型与线程", event["type"] == "approval_required" and event["thread_id"] == "s-1", event["type"])
    check("事件 · 下标顺序保留", [a["index"] for a in event["actions"]] == [0, 1], str([a["index"] for a in event["actions"]]))
    check("事件 · 字段已结构化", event["actions"][0]["fields"][0]["label"] == "状态", str(event["actions"][0]["fields"]))
    check("事件 · 中文标签", event["actions"][0]["label"] == "修改线索", event["actions"][0]["label"])


# --------------------------------------------------------------------------- #
# 3. 真实 HITL 链路（假模型 + 打桩工具，不碰 CRM）
# --------------------------------------------------------------------------- #
executed: list[dict] = []


@tool
def crm_update_lead(lead_id: str, status: str = "", config=None) -> str:
    """修改线索（测试桩）"""
    executed.append({"lead_id": lead_id, "status": status})
    return json.dumps({"ok": True, "lead_id": lead_id, "status": status}, ensure_ascii=False)


class FakeModel(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):  # type: ignore[override]
        return self


def build_agent():
    from deepagents import create_deep_agent

    model = FakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "crm_update_lead", "args": {"lead_id": "LD-1", "status": "成交"}, "id": "c1"}
                ],
            ),
            AIMessage(content="已处理"),
        ]
    )
    return create_deep_agent(
        model=model,
        tools=[crm_update_lead],
        system_prompt="test",
        checkpointer=InMemorySaver(),
        interrupt_on=guard.build_interrupt_on(),
    )


def run_flow(decision: dict) -> tuple[list[str], dict | None, list[str]]:
    """跑一遍「提问 → 中断 → resume」，返回 (updates 的 key 序列, 审批事件, 工具执行记录)。"""
    executed.clear()
    agent = build_agent()
    cfg = {"configurable": {"thread_id": f"t-{uuid.uuid4().hex[:8]}"}}

    keys: list[str] = []
    event: dict | None = None
    for mode, chunk in agent.stream(
        {"messages": [HumanMessage("把 LD-1 改成成交")]}, config=cfg, stream_mode=["messages", "updates"]
    ):
        if mode != "updates":
            continue
        for key, value in (chunk or {}).items():
            keys.append(key)
            if key == "__interrupt__":
                # 模拟 app._stream_events 的处理：tuple 里的 Interrupt 逐个转事件
                for item in value:
                    event = guard.build_approval_event(item.value, cfg["configurable"]["thread_id"], item.id)

    before = [item["lead_id"] for item in executed]

    for _mode, _chunk in agent.stream(Command(resume=decision), config=cfg, stream_mode=["updates"]):
        pass

    after = [item["lead_id"] for item in executed]
    return keys, event, after if after else before


def test_hitl() -> None:
    keys, event, done = run_flow({"decisions": [{"type": "approve"}]})
    check("链路 · 修改操作会中断", "__interrupt__" in keys, f"keys={keys}")
    check("链路 · 中断可转成审批卡", bool(event) and event["actions"][0]["tool"] == "crm_update_lead", str(event and event["actions"][0]["label"]))
    check("链路 · 批准后工具真的执行", done == ["LD-1"], f"executed={done}")

    keys, event, done = run_flow({"decisions": [{"type": "reject", "message": "先别改"}]})
    check("链路 · 拒绝后工具不执行", done == [], f"executed={done}")


def main() -> int:
    test_registry()
    test_summary()
    test_hitl()
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} 通过")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
