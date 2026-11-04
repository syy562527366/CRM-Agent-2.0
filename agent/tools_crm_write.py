"""CRM 写操作工具集：修改数据 / 删除数据。

**当前 Agent 只开放「修改」，不开放「删除」**：`AGENT_DELETE_ENABLED = False`，
删除工具既不会注册给模型（见 `app.py` 的 `TOOLS`），即使被别处重新注册，
函数入口也会直接返回 `FORBIDDEN` 并写审计，形成双重拦截。

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

# 删除开关：产品要求「Agent 不得删除任何数据」，删除只在 CRM 页面由人工完成。
# 这里保留实现（留底逻辑仍可用），但入口一律拒绝。
AGENT_DELETE_ENABLED = False

_DELETE_FORBIDDEN_MESSAGE = (
    "Agent 不提供删除能力：删除动作不可逆，只能由用户在 CRM 列表页手动完成。"
    "请如实告诉用户「我不能删除数据，请在对应列表里自行删除」，"
    "不要改用修改工具变相达成删除效果"
)

# 可修改字段白名单（CRM 字段名 → 中文标签）
# 与 CRM「修改线索」抽屉保持一致：姓名 / 电话 / 优先级 / 来源 / 跟进人 + 业务属性。
# 不含 id / createdAt / communicationCount / lastFollowUpAt：这些是系统维护的，改了会破坏统计与排序。
_LEAD_PATCH = {
    "name": "姓名",
    "phone": "电话",
    "source": "客户来源",
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

# 变更卡片里做脱敏展示的字段
_MASK_IN_DIFF = {"phone"}

_NAME_MAX = 30
_SOURCE_MAX = 20

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
        if field in _MASK_IN_DIFF:
            old, new = mask_phone(old), mask_phone(new)
        rows.append({"field": label, "before": "" if old is None else old, "after": "" if new is None else new})
    return rows


def _check_phone(value: str) -> str:
    """只做常识校验：11 位、以 1 开头。号码格式各国不同，不强求大陆号段，避免把合法数据挡在门外。"""
    digits = "".join(ch for ch in value if ch.isdigit() or ch == "+")
    if not digits.startswith("1") or len(digits) != 11:
        raise ValueError(f"电话「{value}」不像 11 位手机号，请确认后再改（要清空请说明，不支持置空）")
    return digits


# --------------------------------------------------------------------------- #
# 修改
# --------------------------------------------------------------------------- #
@tool
def crm_update_lead(
    lead_id: str,
    name: str = "",
    phone: str = "",
    source: str = "",
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

    用户说「把 X 改成成交」「这条线索转给李华」「名字改成萧山」「电话写错了要改」
    「预算改成 3-5 万」时用它。执行前先确认要改的是哪一条（编号或姓名），不要凭猜测批量改。

    Args:
        lead_id: 线索编号（LD-2026-0001）或客户姓名。姓名匹配到多条会返回 AMBIGUOUS 和候选列表，此时应该问用户而不是重试。
        name: 新客户姓名，1~30 字。留空不改。
        phone: 新手机号，11 位。号码被其他线索占用时会返回 DUPLICATE_PHONE；改号后该客户的历史订单不会自动跟着走，需在结果里提示用户。留空不改。
        source: 新客户来源，例如「抖音」「官网咨询」「转介绍」。留空不改。
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

    # -- 主数据：姓名 / 电话 / 来源（CRM 修改抽屉里也有这三项） --------------- #
    if name.strip():
        value = name.strip()
        if len(value) > _NAME_MAX:
            return dump(fail("INVALID_ARGUMENT", f"姓名最多 {_NAME_MAX} 个字，收到 {len(value)} 个"))
        patch["name"] = value

    phone_value = ""
    if phone.strip():
        try:
            phone_value = _check_phone(phone.strip())
        except ValueError as exc:
            return dump(fail("INVALID_ARGUMENT", str(exc)))
        patch["phone"] = phone_value

    if source.strip():
        value = source.strip()
        if len(value) > _SOURCE_MAX:
            return dump(fail("INVALID_ARGUMENT", f"客户来源最多 {_SOURCE_MAX} 个字，收到 {len(value)} 个"))
        patch["source"] = value

    # -- 业务属性 ------------------------------------------------------------ #
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
                "没有要修改的字段。请明确要改什么（姓名 / 电话 / 来源 / 状态 / 优先级 / 负责人 / "
                "意向产品 / 预算 / 定位 / 试用时长 / 备注）",
                updatable=list(_LEAD_PATCH.values()),
            )
        )

    with CrmClient(ctx) as client:
        lead, resolve_error = _resolve_lead(client, lead_id)
        if resolve_error or not lead:
            return dump(resolve_error or fail("NOT_FOUND", "线索不存在"))

        lead_id_actual = str(lead.get("id", ""))

        # 手机号是订单关联键（orders 通过 customerPhone 找客户），重复会让两套数据串台
        if phone_value:
            dup = client.list("/api/leads", {"phone": phone_value, "page": 1, "pageSize": 10})
            if dup["ok"]:
                others = [
                    {"id": row.get("id", ""), "name": row.get("name", ""), "assignee": row.get("assignee", "")}
                    for row in dup["items"]
                    if str(row.get("id", "")) != lead_id_actual
                ]
                if others:
                    return dump(
                        fail(
                            "DUPLICATE_PHONE",
                            f"手机号 {mask_phone(phone_value)} 已被其他线索占用，不能重复使用，请先核对",
                            conflict=others,
                        )
                    )

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
    if "phone" in patch:
        warnings.append(
            "手机号是订单与线索的关联键：改号后该客户的历史订单仍挂在旧号码上，"
            "报表里可能出现「有订单但查不到客户」，必要时需人工同步订单"
        )
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
                "phone": mask_phone(after.get("phone")),
                "source": after.get("source", ""),
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
    if not AGENT_DELETE_ENABLED:
        _audit(_ctx(config), "crm_delete_lead", "delete", str(lead_id), success=False, error="FORBIDDEN")
        return dump(fail("FORBIDDEN", _DELETE_FORBIDDEN_MESSAGE))

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
    if not AGENT_DELETE_ENABLED:
        _audit(_ctx(config), "crm_delete_order", "delete", str(order_key), success=False, error="FORBIDDEN")
        return dump(fail("FORBIDDEN", _DELETE_FORBIDDEN_MESSAGE))

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


# 注册给 Agent 的写工具：只有「修改」，且每次调用都要过人工审批（见 tools_guard.py）
CRM_UPDATE_TOOLS = [crm_update_lead, crm_update_order]

# 删除工具：实现保留（留底 / 审计逻辑仍可用），但默认不注册、入口直接拒绝。
CRM_DELETE_TOOLS = [crm_delete_lead, crm_delete_order]

# 完整清单（含删除），仅供测试与文档引用，不要直接塞给 Agent
CRM_WRITE_TOOLS = [*CRM_UPDATE_TOOLS, *CRM_DELETE_TOOLS]
