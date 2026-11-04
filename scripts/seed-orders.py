#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
按「成交线索」重建订单数据。

原来的 27 条订单是早期演示数据：商品是 AI课/B端课/C端课（已下架），客户名与线索库无关，
时间全部挤在 2026-06-01 一天。结果是仪表盘算出来的销售额、销售排行、商品统计全是假的。

本脚本的规则：
1. 只从 status=成交 的线索开单 —— 订单的客户名/电话直接取自线索，销售归属才对得上；
2. 商品取线索的意向产品，金额取预算区间中值与商品参考价中「说得通」的那个：
   商品参考价落在预算区间内就用参考价，否则用预算中值（CBAM 6,000 元/份 vs 项目 7.5 万，
   差的是份数，合同额应以预算为准）；
3. 下单时间 = 最后一次跟进之后 1~3 天，落在工作时段，且不晚于当前时刻。

可重复执行：每次先清掉本脚本生成过的订单（OD-2026-#### 且客户来自成交线索）再重建。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
NOW = datetime.now().replace(second=0, microsecond=0)

WORK_START_HOUR = 9
WORK_MINUTES = 540  # 09:00 ~ 17:59

# 商品目录里没有、但线索里出现的意向产品 → 落到目录中实际存在的服务
INTENT_FALLBACK = {
    "入门课": "培训（定制课）",
    "C端课": "培训（定制课）",
    "AI课": "AI 与数字化转型企业培训",
    "B端课": "双碳培训",
}


def load(name: str) -> list[dict]:
    with (DATA / name).open(encoding="utf-8") as fh:
        return json.load(fh)


def save(name: str, rows: list[dict]) -> None:
    with (DATA / name).open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(rows, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def parse_budget(text: str | None) -> tuple[float, float] | None:
    """把「10-30万元」「3000-5000元」解析成元为单位的区间。"""
    if not text:
        return None
    raw = text.replace(" ", "")
    wan = re.fullmatch(r"(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)万元", raw)
    if wan:
        return float(wan.group(1)) * 10000, float(wan.group(2)) * 10000
    yuan = re.fullmatch(r"(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)元", raw)
    if yuan:
        return float(yuan.group(1)), float(yuan.group(2))
    under = re.fullmatch(r"(\d+(?:\.\d+)?)万元以下", raw)
    if under:
        return 0.0, float(under.group(1)) * 10000
    over = re.fullmatch(r"(\d+(?:\.\d+)?)万元以上", raw)
    if over:
        low = float(over.group(1)) * 10000
        return low, low * 2
    return None


def amount_of(lead: dict, price: float) -> float:
    """订单金额：优先级 商品参考价（须落在预算区间）> 预算中值。"""
    band = parse_budget(lead.get("budgetRange"))
    if not band:
        return round(price, 2) if price and price > 0 else 0.0
    low, high = band
    mid = (low + high) / 2
    if price and low <= price <= high:
        return round(price, 2)
    step = 1000 if mid >= 10000 else 100
    return float(round(mid / step) * step)


def product_for(intent: str | None, by_name: dict[str, dict]) -> dict | None:
    if not intent:
        return None
    name = INTENT_FALLBACK.get(intent, intent)
    return by_name.get(name)


def place_order_time(lead: dict, seq: int) -> datetime:
    """下单时刻：最后一次跟进之后 1~3 天，压在工作时段内，且不能晚于现在。"""
    created = datetime.strptime(lead["createdAt"], "%Y-%m-%d %H:%M")
    followed = datetime.strptime(lead.get("lastFollowUpAt") or lead["createdAt"], "%Y-%m-%d %H:%M")
    base = max(created, followed)
    offset_days = 1 + seq % 3
    minutes = (seq * 67) % WORK_MINUTES
    placed = (base + timedelta(days=offset_days)).replace(
        hour=WORK_START_HOUR, minute=0
    ) + timedelta(minutes=minutes)
    if placed > NOW:
        # 不能开未来的单，往前压到今天的工作时段
        placed = NOW - timedelta(minutes=(seq * 17) % 180)
        if placed.hour < WORK_START_HOUR:
            placed = placed.replace(hour=WORK_START_HOUR, minute=15)
    return placed


def stamp(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M")


def build() -> tuple[list[dict], list[dict]]:
    leads = load("leads.json")
    products = load("products.json")
    orders = load("orders.json")

    by_name = {p["name"]: p for p in products}
    deal_leads = sorted(
        (l for l in leads if l.get("status") == "成交"),
        key=lambda l: (l["createdAt"], l["id"]),
    )
    deal_phones = {l["phone"] for l in deal_leads}

    # 1) 清掉上一轮生成过的订单，保留人工新增的（客户不在成交线索里）
    #    另外一并清掉挂在已下架商品上的早期演示订单 —— 商品都下架了，订单还留着只会污染统计
    active_ids = {p["id"] for p in products if p.get("status") == "上架"}
    kept = [
        o for o in orders
        if o.get("productId") in active_ids
        and not (re.fullmatch(r"OD-2026-\d{4}", o.get("id", "")) and o.get("customerPhone") in deal_phones)
    ]

    drafted: list[dict] = []
    for seq, lead in enumerate(deal_leads):
        product = product_for(lead.get("intentProduct"), by_name)
        if not product:
            print(f"  ! 跳过 {lead['id']}：意向产品「{lead.get('intentProduct')}」不在商品目录")
            continue
        price = float(product.get("price") or 0)
        drafted.append(
            {
                "createdAt": place_order_time(lead, seq),
                "customerName": lead["name"],
                "customerPhone": lead["phone"],
                "productId": product["id"],
                "productNo": product.get("productNo") or product["id"],
                "productName": product["name"],
                "amount": amount_of(lead, price),
            }
        )

    # 2) 按时间排序后分配单号：id 越大越新，orderNo 的日期与流水取自下单日
    drafted.sort(key=lambda o: o["createdAt"])
    per_day: dict[str, int] = {}
    for index, order in enumerate(drafted, start=1):
        day = order["createdAt"].strftime("%Y%m%d")
        per_day[day] = per_day.get(day, 0) + 1
        order["id"] = f"OD-2026-{index:04d}"
        order["orderNo"] = f"ORD-{day}{per_day[day]:03d}"
        order["createdAt"] = stamp(order["createdAt"])

    # 3) 落盘时新的在前，与 createOrder 的 unshift 行为一致
    rows = [reorder(o) for o in reversed(drafted)] + kept
    return rows, drafted


def reorder(order: dict) -> dict:
    """保持字段顺序稳定，避免每次重跑都产生大段 diff。"""
    keys = ["id", "createdAt", "orderNo", "customerName", "customerPhone", "productId", "productNo", "productName", "amount"]
    return {k: order[k] for k in keys if k in order}


def main() -> None:
    rows, drafted = build()
    if not drafted:
        print("没有可开单的成交线索，未写入")
        return

    save("orders.json", rows)

    total = sum(o["amount"] for o in drafted)
    print(f"订单 {len(rows)} 条（本次生成 {len(drafted)} 条）")
    print(f"合同额合计 ¥{total:,.0f}，客单价 ¥{total / len(drafted):,.0f}")
    print("时间范围：", drafted[0]["createdAt"], "~", drafted[-1]["createdAt"])

    from collections import Counter

    print("月份分布：", dict(sorted(Counter(o["createdAt"][:7] for o in drafted).items())))
    print("商品分布：")
    for name, count in Counter(o["productName"] for o in drafted).most_common():
        amount = sum(o["amount"] for o in drafted if o["productName"] == name)
        print(f"  {count:>3} 单  ¥{amount:>12,.0f}  {name}")


if __name__ == "__main__":
    main()
