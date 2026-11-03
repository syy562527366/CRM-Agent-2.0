"""CRM 写操作工具集：修改数据 / 删除数据。

与只读工具同一套纪律，另加三条写操作专属约束：

1. **白名单补丁**：只有列在 `_LEAD_PATCH` / `_ORDER_PATCH` 里的字段能改。
   CRM 的 PUT 是 `{...old, ...body}` 全量覆盖，若直接转发模型给的 body，
   模型就能顺手改 id / createdAt / communicationCount。
2. **先读后写**：每次写操作先 GET 原记录，一是确认可见（数据范围「仅自己」时
   别人的记录会 404），二是拿到 before 快照做 diff 给用户看。
3. **删除留底**：删之前把整条记录写进 `data/trash.jsonl`，误删可人工回捞；
   所有写操作无论成败都记 `data/audit.jsonl`（谁、哪个工具、改了什么）。

权限上，本地先按 permissions 拦一次（修改 / 删除功能位），CRM API 再按
Bearer token 校验一次；两步都过才会真正落盘。
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from crm_client import CrmClient, CrmCtx, dump, fail, mask_phone, ok
from tools_crm import _ctx, _emit, _normalize_priority, _normalize_status

_DATA_DIR = Path(__file__).resolve().parent / "data"
AUDIT_PATH = _DATA_DIR / "audit.jsonl"
TRASH_PATH = _DATA_DIR / "trash.jsonl"

_io_lock = threading.Lock()

# 可修改字段白名单（CRM 字段名 → 中文标签）
_LEAD_PATCH = {
    "status": "状态",
    "priority": "优先级",
    "assignee": "负责人",
    "intentProduct": "意向产品",
    "budgetRange": "预算区间",
    "customerPosition": "客户定位",
    "trialDuration": "试用时长",
    "remark": "备注",
}
_ORDER_PATCH = {"amount": "金额"}

_LEAD_DELETE_COLUMNS = ["id", "name", "status", "priority", "assignee", "lastFollowUpAt"]
_ORDER_DELETE_COLUMNS = ["orderNo", "customerName", "productName", "amount", "createdAt"]


def _stamp() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _append(path: Path, payload: dict[str, Any]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(payload, ensure_ascii=False)
        with _io_lock:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
    except OSError:
        # 留痕失败不能反过来把业务操作搞挂
        pass


def _audit(
    ctx: CrmCtx,
    tool_name: str,
    action: str,
    target: str,
    changes: list[dict[str, Any]] | None = None,
    success: bool = True,
    error: str = "",
) -> None:
    _append(
        AUDIT_PATH,
        {
            "ts": _stamp(),
            "uid": ctx.uid,
            "name": ctx.name,
            "role": ctx.role_name,
            "tool": tool_name,
            "action": action,
            "target": target,
            "changes": changes or [],
            "ok": success,
            "error": error,
        },
    )


def _guard_write(
    config: RunnableConfig | None, page_key: str, action: str
) -> tuple[CrmCtx, dict[str, Any] | None]:
    """身份 + 功能权限校验（写操作要的是修改 / 删除功能位，不是查看）。"""
    ctx = _ctx(config)
    if ctx.is_anonymous:
        return ctx, fail("UNAUTHORIZED", "未获取到调用者身份，请让用户刷新页面重新登录")
    if not ctx.can(page_key, action):
        return ctx, fail(
            "PERMISSION_DENIED",
            f"当前账号（{ctx.role_name or '未知角色'}）没有「{page_key}」的{action}权限。"
            "请如实告知用户，不要改用其他工具绕过",
        )
    return ctx, None


# --------------------------------------------------------------------------- #
# 定位目标记录
# --------------------------------------------------------------------------- #
def _resolve_lead(
    client: CrmClient, key: str
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """把「LD-2026-0002」或「王小明」解析成一条唯一的线索。

    返回 (lead, 错误信封)；错误信封可能是 AMBIGUOUS，此时 message 里带候选，
    让模型去问用户而不是挑一个动手。
    """
    key = (key or "").strip()
    if not key:
        return None, fail("INVALID_ARGUMENT", "请提供线索编号（LD-2026-0001）或客户姓名")

    if key.upper().startswith("LD-"):
        result = client.get(f"/api/leads/{key.upper()}")
        if result["ok"] and isinstance(result["body"], dict) and result["body"].get("id"):
            return result["body"], None
        return None, fail(
            "NOT_FOUND",
            f"没有编号为 {key} 的线索，或它不在你的数据范围内。"
            "可以先用 crm_search_leads 找到正确编号",
            lead_id=key,
        )

    found = client.list("/api/leads", {"keyword": key, "page": 1, "pageSize": 10})
    if not found["ok"]:
        return None, fail(found["error"], found["message"])
    rows = [row for row in found["items"] if str(row.get("name", "")) == key] or found["items"]

    if not rows:
        return None, fail("NOT_FOUND", f"没有找到与「{key}」匹配的线索")
    if len(rows) > 1:
        candidates = [
            {"id": r.get("id", ""), "name": r.get("name", ""), "phone": mask_phone(r.get("phone")),
             "assignee": r.get("assignee", ""), "status": r.get("status", "")}
            for r in rows
        ]
        return None, fail(
            "AMBIGUOUS",
            f"「{key}」匹配到 {len(rows)} 条线索，无法确定要改哪一条，请让用户确认编号",
            candidates=candidates,
        )
    return rows[0], None


def _resolve_order(
    client: CrmClient, key: str
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    key = (key or "").strip()
    if not key:
        return None, fail("INVALID_ARGUMENT", "请提供订单号（OD-2026-0001）")

    result = client.get(f"/api/orders/{key.upper()}")
    if result["ok"] and isinstance(result["body"], dict) and result["body"].get("id"):
        return result["body"], None

    found = client.list("/api/orders", {"orderNo": key, "page": 1, "pageSize": 10})
    if not found["ok"]:
        return None, fail(found["error"], found["message"])
    rows = [row for row in found["items"] if str(row.get("orderNo", "")).upper() == key.upper()]
    if len(rows) == 1:
        return rows[0], None
    if len(rows) > 1:
        return None, fail("AMBIGUOUS", f"订单号「{key}」匹配到多条记录，请提供更完整的订单号")
    return None, fail("NOT_FOUND", f"没有找到订单「{key}」")


def _diff(before: dict[str, Any], after: dict[str, Any], labels: dict[str, str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for field, label in labels.items():
        old, new = before.get(field), after.get(field)
        if str(old or "") == str(new or ""):
            continue
        rows.append({"field": label, "before": "" if old is None else old, "after": "" if new is None else new})
    return rows


# --------------------------------------------------------------------------- #
# 修改
# --------------------------------------------------------------------------- #
@tool
def crm_update_lead(
    lead_id: str,
    status: str = "",
    priority: str = "",
    assignee: str = "",
    intent_product: str = "",
    budget_range: str = "",
    customer_position: str = "",
    trial_duration: str = "",
    remark: str = "",
    config: RunnableConfig = None,
) -> str:
    """修改单条线索的资料。只传需要改的字段，没传的字段保持原样。

    用户说「把 X 改成成交」「这条线索转给李华」「预算改成 3-5 万」时用它。
    执行前请先确认用户要改的是哪一条（编号或姓名），不要凭猜测批量改。

    Args:
        lead_id: 线索编号（LD-2026-0001）或客户姓名。姓名匹配到多条会返回 AMBIGUOUS 和候选列表，此时应该问用户而不是重试。
        status: 新状态：成交 / 客户流失 / 未接触 / 长期未跟进 / 推荐产品 / 价格异议。留空不改。
        priority: 新意向等级：high / medium / low。留空不改。
        assignee: 新负责人姓名，例如「李华」。留空不改。
        intent_product: 意向产品名称。留空不改。
        budget_range: 预算区间，例如「3-5万」。留空不改。
        customer_position: 客户定位描述。留空不改。
        trial_duration: 试用时长，例如「14天」。留空不改。
        remark: 客户备注。留空不改。
    """
    ctx, denied = _guard_write(config, "leads", "修改")
    if denied:
        return dump(denied)

    patch: dict[str, Any] = {}
    if status.strip():
        norm, error = _normalize_status(status)
        if error:
            return dump(fail("INVALID_ARGUMENT", error))
        patch["status"] = norm
    if priority.strip():
        norm, error = _normalize_priority(priority)
        if error:
            return dump(fail("INVALID_ARGUMENT", error))
        patch["priority"] = norm
    for field, value in (
        ("assignee", assignee),
        ("intentProduct", intent_product),
        ("budgetRange", budget_range),
        ("customerPosition", customer_position),
        ("trialDuration", trial_duration),
        ("remark", remark),
    ):
        if value and value.strip():
            patch[field] = value.strip()

    if not patch:
        return dump(
            fail(
                "INVALID_ARGUMENT",
                "没有要修改的字段。请明确要改什么（状态 / 优先级 / 负责人 / 意向产品 / 预算 / 定位 / 试用时长 / 备注）",
                updatable=list(_LEAD_PATCH.values()),
            )
        )

    with CrmClient(ctx) as client:
        lead, resolve_error = _resolve_lead(client, lead_id)
        if resolve_error or not lead:
            return dump(resolve_error or fail("NOT_FOUND", "线索不存在"))

        lead_id_actual = str(lead.get("id", ""))
        target = f"{lead_id_actual}({lead.get('name', '')})"
        result = client.put(f"/api/leads/{lead_id_actual}", patch)

    if not result["ok"]:
        _audit(ctx, "crm_update_lead", "update", target, [{"field": k, "after": v} for k, v in patch.items()],
               success=False, error=result["error"])
        return dump(fail(result["error"], result["message"], lead_id=lead_id_actual))

    after = result["body"] or {}
    changes = _diff(lead, after, _LEAD_PATCH)

    warnings: list[str] = []
    if not changes:
        warnings.append("提交的值与原值一致，数据没有实际变化")
    if ctx.own_only("leads") and "assignee" in patch and patch["assignee"] != ctx.name:
        warnings.append(
            f"线索已转给 {patch['assignee']}，你的数据范围是「仅自己」，之后可能看不到这条线索"
        )

    _emit(
        config,
        tool="crm_update_lead",
        kind="change_table",
        title=f"修改线索 {lead_id_actual}",
        columns=["field", "before", "after"],
        rows=changes,
        total=len(changes),
    )
    _audit(ctx, "crm_update_lead", "update", target, changes)

    return dump(
        ok(
            action="update",
            lead_id=lead_id_actual,
            name=after.get("name", ""),
            changed=changes,
            lead={
                "id": lead_id_actual,
                "name": after.get("name", ""),
                "status": after.get("status", ""),
                "priority": after.get("priority", ""),
                "assignee": after.get("assignee", ""),
                "intentProduct": after.get("intentProduct", ""),
                "budgetRange": after.get("budgetRange", ""),
                "lastFollowUpAt": after.get("lastFollowUpAt", ""),
            },
            warnings=warnings,
            note="changed 是本次真正变化的字段（旧值 → 新值）",
        )
    )


@tool
def crm_update_order(order_key: str, amount: float, config: RunnableConfig = None) -> str:
    """调整订单金额（对账、补录优惠后金额时用）。客户与商品不允许通过工具改，那属于重开单。

    Args:
        order_key: 订单号，例如 OD-2026-0001。
        amount: 新金额，单位元，必须大于 0。
    """
    ctx, denied = _guard_write(config, "orders", "修改")
    if denied:
        return dump(denied)

    try:
        new_amount = round(float(amount), 2)
    except (TypeError, ValueError):
        return dump(fail("INVALID_ARGUMENT", f"金额必须是数字，收到「{amount}」"))
    if new_amount <= 0:
        return dump(fail("INVALID_ARGUMENT", "订单金额必须大于 0；要作废订单请用删除工具"))

    with CrmClient(ctx) as client:
        order, resolve_error = _resolve_order(client, order_key)
        if resolve_error or not order:
            return dump(resolve_error or fail("NOT_FOUND", "订单不存在"))

        order_id = str(order.get("id", ""))
        target = str(order.get("orderNo", order_key))
        old_amount = float(order.get("amount") or 0)
        result = client.put(f"/api/orders/{order_id}", {"amount": new_amount})

    if not result["ok"]:
        _audit(ctx, "crm_update_order", "update", target, [{"field": "金额", "before": old_amount, "after": new_amount}],
               success=False, error=result["error"])
        return dump(fail(result["error"], result["message"], order_no=target))

    after = result["body"] or {}
    changes = [{"field": "金额", "before": old_amount, "after": after.get("amount", new_amount)}]
    warnings = []
    if abs(new_amount - old_amount) >= max(old_amount * 0.5, 1):
        warnings.append("金额变动超过 50%，请确认这是用户想要的数")

    _emit(
        config,
        tool="crm_update_order",
        kind="change_table",
        title=f"修改订单 {target}",
        columns=["field", "before", "after"],
        rows=changes,
        total=1,
    )
    _audit(ctx, "crm_update_order", "update", target, changes)

    return dump(
        ok(
            action="update",
            order_no=target,
            customer_name=after.get("customerName", ""),
            changed=changes,
            warnings=warnings,
            note="订单金额会直接进入销售统计",
        )
    )


# --------------------------------------------------------------------------- #
# 删除
# --------------------------------------------------------------------------- #
@tool
def crm_delete_lead(lead_id: str, reason: str = "", config: RunnableConfig = None) -> str:
    """删除单条线索（不可在对话里撤销，删除前记录会留底在服务端 trash.jsonl）。

    这是不可逆操作：只有在用户明确说「删除 / 清掉 / 作废」某条线索时才调用。
    用户表达含糊（例如「把没用的线索删掉」）时，先查询并列出候选让用户确认编号。

    Args:
        lead_id: 线索编号（LD-2026-0001）。可传客户姓名，但仅当只匹配到一条时才执行。
        reason: 删除原因，会记进审计日志，便于事后追溯。例如「重复录入」。
    """
    ctx, denied = _guard_write(config, "leads", "删除")
    if denied:
        return dump(denied)

    with CrmClient(ctx) as client:
        lead, resolve_error = _resolve_lead(client, lead_id)
        if resolve_error or not lead:
            return dump(resolve_error or fail("NOT_FOUND", "线索不存在"))

        lead_id_actual = str(lead.get("id", ""))
        target = f"{lead_id_actual}({lead.get('name', '')})"
        result = client.delete(f"/api/leads/{lead_id_actual}")

    if not result["ok"]:
        _audit(ctx, "crm_delete_lead", "delete", target, success=False, error=result["error"])
        return dump(fail(result["error"], result["message"], lead_id=lead_id_actual))

    _append(
        TRASH_PATH,
        {"ts": _stamp(), "uid": ctx.uid, "name": ctx.name, "tool": "crm_delete_lead", "reason": reason, "row": lead},
    )
    _audit(ctx, "crm_delete_lead", "delete", target)

    snapshot = {k: lead.get(k, "") for k in _LEAD_DELETE_COLUMNS}
    _emit(
        config,
        tool="crm_delete_lead",
        kind="delete_table",
        title=f"已删除线索 {lead_id_actual}",
        columns=_LEAD_DELETE_COLUMNS,
        rows=[snapshot],
        total=1,
    )

    return dump(
        ok(
            action="delete",
            lead_id=lead_id_actual,
            name=lead.get("name", ""),
            deleted=snapshot,
            reason=reason,
            note="已删除，原记录已留底在服务端 data/trash.jsonl，必要时可由管理员回捞",
        )
    )


@tool
def crm_delete_order(order_key: str, reason: str = "", config: RunnableConfig = None) -> str:
    """删除订单（不可逆，删除前记录会留底）。仅用于用户明确要求作废 / 删除某笔订单。

    Args:
        order_key: 订单号，例如 OD-2026-0001。
        reason: 删除原因，记进审计日志。
    """
    ctx, denied = _guard_write(config, "orders", "删除")
    if denied:
        return dump(denied)

    with CrmClient(ctx) as client:
        order, resolve_error = _resolve_order(client, order_key)
        if resolve_error or not order:
            return dump(resolve_error or fail("NOT_FOUND", "订单不存在"))

        order_id = str(order.get("id", ""))
        target = str(order.get("orderNo", order_key))
        result = client.delete(f"/api/orders/{order_id}")

    if not result["ok"]:
        _audit(ctx, "crm_delete_order", "delete", target, success=False, error=result["error"])
        return dump(fail(result["error"], result["message"], order_no=target))

    _append(
        TRASH_PATH,
        {"ts": _stamp(), "uid": ctx.uid, "name": ctx.name, "tool": "crm_delete_order", "reason": reason, "row": order},
    )
    _audit(ctx, "crm_delete_order", "delete", target)

    snapshot = {k: order.get(k, "") for k in _ORDER_DELETE_COLUMNS}
    _emit(
        config,
        tool="crm_delete_order",
        kind="delete_table",
        title=f"已删除订单 {target}",
        columns=_ORDER_DELETE_COLUMNS,
        rows=[snapshot],
        total=1,
    )

    return dump(
        ok(
            action="delete",
            order_no=target,
            amount=order.get("amount", 0),
            deleted=snapshot,
            reason=reason,
            note="订单金额已从销售统计中扣除",
        )
    )


CRM_WRITE_TOOLS = [
    crm_update_lead,
    crm_update_order,
    crm_delete_lead,
    crm_delete_order,
]
