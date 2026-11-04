"""写操作工具的自测脚本（不经过大模型，直接调用工具函数）。

覆盖：修改线索 / 修改订单，以及权限拒绝、参数校验、目标不存在、重名歧义、审计留痕；
另外验证「Agent 禁止删除」这条硬约束（删除工具入口一律 FORBIDDEN，且不注册给模型）。

运行前需保证 CRM（3100）已启动。脚本自己创建测试数据并清理；
对既有数据的改动只动状态和金额，结束时按原值还原。

    agent/.venv/Scripts/python.exe agent/test_write_tools.py
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import sys
import time
from pathlib import Path

import httpx  # noqa: F401  （CrmClient 内部用；此处仅保持依赖显式）
import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "agent"))

from crm_client import CrmCtx  # noqa: E402
from tools_crm_write import (  # noqa: E402
    AGENT_DELETE_ENABLED,
    AUDIT_PATH,
    CRM_DELETE_TOOLS,
    crm_delete_lead,
    crm_delete_order,
    crm_update_lead,
    crm_update_order,
)

CRM = "http://127.0.0.1:3100"
SECRET = "crm-local-dev-secret-please-override"

results: list[tuple[str, bool, str]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    results.append((name, passed, detail))
    print(f"{'PASS' if passed else 'FAIL'} | {name} | {detail}")


# --------------------------------------------------------------------------- #
# 造一个真实会话 token（与 src/lib/auth/session.ts 同算法）
# --------------------------------------------------------------------------- #
def make_token(uid: str, rid: str, ttl: int = 3600) -> str:
    payload = json.dumps({"uid": uid, "rid": rid, "exp": int(time.time()) + ttl})
    body = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    sig = hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).digest()
    return f"{body}.{base64.urlsafe_b64encode(sig).decode().rstrip('=')}"


def load_ctx(account_id: str) -> CrmCtx:
    accounts = json.loads((ROOT / "data" / "accounts.json").read_text(encoding="utf-8"))
    roles = json.loads((ROOT / "data" / "roles.json").read_text(encoding="utf-8"))
    account = next(a for a in accounts if a["id"] == account_id)
    role = next(r for r in roles if r["id"] == account["roleId"])
    return CrmCtx(
        uid=account["id"],
        name=account["name"],
        role_id=role["id"],
        role_name=role["name"],
        token=make_token(account["id"], role["id"]),
        permissions=tuple(role["permissions"]),
    )


def cfg(ctx: CrmCtx, sink: list | None = None) -> dict:
    return {"configurable": {"crm_ctx": ctx, "tool_data_sink": sink if sink is not None else []}}


class Api:
    """造数据 / 校验用的小封装。

    用 requests 而不是 httpx：Next dev 对 httpx 的 POST 会偶发 308 自跳转，
    requests 的 redirect 处理更稳。
    """

    def __init__(self, headers: dict[str, str]):
        self.headers = headers

    def __enter__(self) -> "Api":
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def get(self, path: str, params: dict | None = None) -> requests.Response:
        return requests.get(CRM + path, headers=self.headers, params=params, timeout=10)

    def post(self, path: str, json: dict | None = None) -> requests.Response:
        return requests.post(CRM + path, headers=self.headers, json=json, timeout=10)

    def delete(self, path: str) -> requests.Response:
        """测试数据清理用（Agent 自己没有删除能力，只能由测试脚本直连 CRM 清场）。"""
        return requests.delete(CRM + path, headers=self.headers, timeout=10)


def call(tool, args: dict, ctx: CrmCtx, sink: list | None = None) -> dict:
    return json.loads(tool.invoke(args, config=cfg(ctx, sink)))


def lines(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]


# --------------------------------------------------------------------------- #
def main() -> int:
    admin = load_ctx("ACCT-2026-0001")
    sales = load_ctx("ACCT-2026-0002")

    h = {"Authorization": f"Bearer {admin.token}"}
    with Api(h) as api:
        try:
            api.get("/api/auth/session").raise_for_status()
        except Exception as exc:  # noqa: BLE001
            print(f"CRM 不可用（{CRM}）：{exc}")
            return 1

        # ------------------------------------------------------------ 造测试数据
        created = []
        for i in range(2):
            resp = api.post(
                "/api/leads",
                json={"name": "测试同名", "phone": f"1370000{i:04d}", "priority": "low",
                      "source": "抖音", "assignee": "张明"},
            )
            if resp.status_code not in (200, 201):
                print(f"创建线索失败 HTTP {resp.status_code}: {resp.text[:120]}")
                return 1
            created.append(resp.json())
        check("准备 · 建两条同名线索", len({c["id"] for c in created}) == 2, created[0]["id"] + " / " + created[1]["id"])
        # ------------------------------------------------------------ 修改线索
        sink: list = []
        r = call(crm_update_lead, {"lead_id": created[0]["id"], "status": "成交", "budget_range": "5-8万"}, admin, sink)
        changed = {c["field"]: c for c in r.get("changed", [])}
        check(
            "修改线索 · 多字段",
            r.get("ok") and changed.get("状态", {}).get("after") == "成交" and "预算区间" in changed,
            f"changed={list(changed)}",
        )
        check(
            "修改线索 · 明细卡片",
            bool(sink) and sink[0]["kind"] == "change_table" and len(sink[0]["rows"]) == len(changed),
            f"kind={sink[0]['kind'] if sink else None}",
        )
        after = api.get(f"/api/leads/{created[0]['id']}").json()
        check("修改线索 · 已落盘", after["status"] == "成交" and after.get("budgetRange") == "5-8万", f"status={after['status']}")

        # 真实线索：改状态再还原（原值明确，可安全回滚）
        real = api.get("/api/leads/LD-2026-0002").json()
        origin_status = real["status"]
        call(crm_update_lead, {"lead_id": "LD-2026-0002", "status": "成交"}, admin)
        bounced = api.get("/api/leads/LD-2026-0002").json()
        call(crm_update_lead, {"lead_id": "LD-2026-0002", "status": origin_status}, admin)
        restored = api.get("/api/leads/LD-2026-0002").json()
        check(
            "修改线索 · 既有数据改后还原",
            bounced["status"] == "成交" and restored["status"] == origin_status,
            f"{origin_status} → 成交 → {restored['status']}",
        )

        # 校验类
        r = call(crm_update_lead, {"lead_id": created[0]["id"]}, admin)
        check("修改线索 · 空字段被拒", r.get("error") == "INVALID_ARGUMENT", r.get("message", "")[:34])

        r = call(crm_update_lead, {"lead_id": "LD-2026-9999", "status": "成交"}, admin)
        check("修改线索 · 编号不存在", r.get("error") == "NOT_FOUND", r.get("message", "")[:34])

        r = call(crm_update_lead, {"lead_id": created[0]["id"], "status": "乱写"}, admin)
        check("修改线索 · 非法状态", r.get("error") == "INVALID_ARGUMENT", r.get("message", "")[:34])

        r = call(crm_update_lead, {"lead_id": created[0]["id"], "priority": "超高"}, admin)
        check("修改线索 · 非法优先级", r.get("error") == "INVALID_ARGUMENT", r.get("message", "")[:34])

        # ------------------------------------------------- 主数据：姓名 / 电话 / 来源
        sink = []
        r = call(crm_update_lead, {"lead_id": created[1]["id"], "name": "萧山", "source": "转介绍"}, admin, sink)
        renamed = {c["field"]: c for c in r.get("changed", [])}
        check(
            "修改线索 · 改姓名与来源",
            r.get("ok") and renamed.get("姓名", {}).get("after") == "萧山" and "客户来源" in renamed,
            f"changed={list(renamed)}",
        )
        after = api.get(f"/api/leads/{created[1]['id']}").json()
        check("修改线索 · 姓名已落盘", after["name"] == "萧山" and after["source"] == "转介绍", f"{after['name']} / {after['source']}")

        new_phone = "13600001234"
        r = call(crm_update_lead, {"lead_id": created[1]["id"], "phone": new_phone}, admin)
        phone_change = {c["field"]: c for c in r.get("changed", [])}.get("电话", {})
        check(
            "修改线索 · 改电话且脱敏展示",
            r.get("ok") and "****" in str(phone_change.get("after")) and any("订单" in w for w in r.get("warnings", [])),
            f"{phone_change.get('before')} → {phone_change.get('after')}",
        )
        after = api.get(f"/api/leads/{created[1]['id']}").json()
        check("修改线索 · 电话已落盘", after["phone"] == new_phone, after["phone"])

        r = call(crm_update_lead, {"lead_id": created[0]["id"], "phone": new_phone}, admin)
        check(
            "修改线索 · 电话重复被拒",
            r.get("error") == "DUPLICATE_PHONE" and bool(r.get("conflict")),
            r.get("message", "")[:40],
        )

        r = call(crm_update_lead, {"lead_id": created[0]["id"], "phone": "12345"}, admin)
        check("修改线索 · 非法电话被拒", r.get("error") == "INVALID_ARGUMENT", r.get("message", "")[:34])

        r = call(crm_update_lead, {"lead_id": created[0]["id"], "name": "名" * 31}, admin)
        check("修改线索 · 姓名超长被拒", r.get("error") == "INVALID_ARGUMENT", r.get("message", "")[:34])

        # 姓名改回，保证后面「重名歧义」与「按姓名删除」的用例前提成立
        r = call(crm_update_lead, {"lead_id": created[1]["id"], "name": "测试同名"}, admin)
        check("修改线索 · 姓名改回", r.get("ok"), str(r.get("changed", []))[:50])


        # ------------------------------------------------------------ 重名歧义
        r = call(crm_update_lead, {"lead_id": "测试同名", "status": "成交"}, admin)
        check(
            "修改线索 · 重名返回候选",
            r.get("error") == "AMBIGUOUS" and len(r.get("candidates", [])) >= 2,
            f"候选 {len(r.get('candidates', []))} 条",
        )
        untouched = api.get(f"/api/leads/{created[1]['id']}").json()
        check("修改线索 · 歧义时不落盘", not untouched.get("status"), f"status={untouched.get('status')!r}")

        # ------------------------------------------------------------ 禁止删除
        check("删除 · 开关处于关闭状态", AGENT_DELETE_ENABLED is False, f"AGENT_DELETE_ENABLED={AGENT_DELETE_ENABLED}")
        check("删除 · 删除工具仍保留实现", len(CRM_DELETE_TOOLS) == 2, "留档但不开放，注册校验见 test_guard.py")

        r = call(crm_delete_lead, {"lead_id": created[0]["id"], "reason": "自测清理"}, admin)
        check("删除线索 · Agent 被禁止", r.get("error") == "FORBIDDEN", r.get("message", "")[:40])
        check(
            "删除线索 · 被拒后数据仍在",
            api.get(f"/api/leads/{created[0]['id']}").status_code == 200,
            "",
        )

        # 清理测试数据：直连 CRM（Agent 无删除能力，只能由测试脚本清场）
        cleaned = [
            api.delete(f"/api/leads/{row['id']}").status_code for row in created
        ]
        check("清理 · 直连 CRM 删除测试线索", all(code in (200, 204) for code in cleaned), f"HTTP {cleaned}")

        # ------------------------------------------------------------ 权限
        cur_priority = api.get("/api/leads/LD-2026-0003").json().get("priority") or "medium"
        target_priority = "low" if cur_priority != "low" else "high"
        r = call(crm_update_lead, {"lead_id": "LD-2026-0003", "priority": target_priority}, sales)
        check(
            "权限 · 销售可修改",
            r.get("ok") and r.get("action") == "update" and bool(r.get("changed")),
            f"{cur_priority} → {target_priority}，changed={[c['field'] for c in r.get('changed', [])]}",
        )
        call(crm_update_lead, {"lead_id": "LD-2026-0003", "priority": cur_priority}, sales)

        r = call(crm_update_lead, {"lead_id": "LD-2026-0003", "status": "成交"}, CrmCtx())
        check("权限 · 无身份被拒", r.get("error") == "UNAUTHORIZED", r.get("message", "")[:30])

        # ------------------------------------------------------------ 修改订单
        orders = api.get("/api/orders", params={"pageSize": 1}).json()["data"]
        products = api.get("/api/products", params={"pageSize": 1}).json()["data"]
        if orders:
            order = orders[0]
            origin_amount = order["amount"]
            sink = []
            r = call(crm_update_order, {"order_key": order["orderNo"], "amount": origin_amount + 40}, admin, sink)
            check(
                "修改订单 · 金额",
                r.get("ok") and r["changed"][0]["after"] == origin_amount + 40,
                f"{origin_amount} → {r['changed'][0]['after'] if r.get('changed') else '?'}",
            )
            check("修改订单 · 卡片", bool(sink) and sink[0]["kind"] == "change_table", f"kind={sink[0]['kind'] if sink else None}")

            r = call(crm_update_order, {"order_key": order["orderNo"], "amount": origin_amount}, admin)
            back = api.get(f"/api/orders/{order['id']}").json()
            check("修改订单 · 还原", r.get("ok") and back["amount"] == origin_amount, f"回到 {back['amount']}")

            r = call(crm_update_order, {"order_key": order["orderNo"], "amount": 0}, admin)
            check("修改订单 · 金额必须为正", r.get("error") == "INVALID_ARGUMENT", r.get("message", "")[:30])

            r = call(crm_update_order, {"order_key": "ORD-不存在", "amount": 100}, admin)
            check("修改订单 · 订单号不存在", r.get("error") == "NOT_FOUND", r.get("message", "")[:30])

            # -------------------------------------------------------- 删除订单（应被禁止）
            if products:
                lead_phone = api.get("/api/leads/LD-2026-0002").json()["phone"]
                made = api.post("/api/orders", json={"customerPhone": lead_phone, "productId": products[0]["id"]})
                if made.status_code in (200, 201):
                    new_order = made.json()
                    r = call(crm_delete_order, {"order_key": new_order["orderNo"], "reason": "自测清理"}, admin)
                    check("删除订单 · Agent 被禁止", r.get("error") == "FORBIDDEN", r.get("message", "")[:40])
                    check(
                        "删除订单 · 被拒后数据仍在",
                        api.get(f"/api/orders/{new_order['id']}").status_code == 200,
                        "",
                    )
                    check(
                        "清理 · 直连 CRM 删除测试订单",
                        api.delete(f"/api/orders/{new_order['id']}").status_code in (200, 204),
                        new_order["orderNo"],
                    )
                else:
                    check("删除订单 · Agent 被禁止", False, f"测试订单创建失败 HTTP {made.status_code} {made.text[:60]}")

    # -------------------------------------------------------------------- 留痕
    audit = lines(AUDIT_PATH)
    tools_hit = {row["tool"] for row in audit}
    check(
        "审计 · 修改操作有记录",
        {"crm_update_lead", "crm_update_order"} <= tools_hit,
        f"累计 {len(audit)} 条 / {len(tools_hit)} 种工具",
    )
    blocked = [row for row in audit if row["tool"].startswith("crm_delete") and row.get("error") == "FORBIDDEN"]
    check("审计 · 被禁止的删除也留痕", bool(blocked), f"累计 {len(blocked)} 条 FORBIDDEN")
    failed_logged = [row for row in audit if not row["ok"]]
    check("审计 · 失败也留痕", bool(failed_logged), f"失败 {len(failed_logged)} 条")

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} 通过")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
