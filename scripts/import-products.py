"""从两份合同汇总表重新生成 data/products.json（商品目录）。

用法：
    python scripts/import-products.py

数据源（两文件都在 D:/工作/2026/数据看板/）：
    2022-2024 碳启城+碳之邦+曼研院  项目汇总（20241225）(1).xlsx / 2023-2024合同
    2025-2026碳启城项目汇总.xlsx / 导入文档

为什么要有这个脚本，而不是手工维护 JSON：
    表格是「合同订单」导出格式，商品信息藏在横向展开的多行子表里
    （产品名称/产品编号/规格/销售单位/数量/单价/售价…），一次导出 200+ 行。
    手工摘录既要算成交量又要防错行，脚本可以把规则写死、可重复执行。

三条经验规则（都是踩出来的，改动前先读）：
1. **表头跨行合并**：三层表头（大标题 / 合同字段 / 产品子表头），
   只看单行会漏列——合同字段行没有「产品名称」，子表头行没有「合同编号」。
2. **「单价」列不可靠**：绿证/碳交易里它恒为 200000（明显是脏数据），
   真单价在「售价（元）」。已用 subtotal ≈ qty × salePrice 验证。
3. **参考价取按笔数加权的中位数**：不能对去重后的价格集合求中位数，
   否则 20000 元成交 1 笔、6000 元成交 60 笔时会算成 10000。
   区间同理，超过中位数 10 倍的行视为打包价/录错，不进区间。
"""

from __future__ import annotations

import json
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from xlsx_read import read_workbook, to_grid  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "data" / "products.json"

SOURCES = [
    Path(r"D:\工作\2026\数据看板\2022-2024 碳启城+碳之邦+曼研院  项目汇总（20241225）(1).xlsx"),
    Path(r"D:\工作\2026\数据看板\2025-2026碳启城项目汇总.xlsx"),
]

IMPORT_STAMP = "2026-11-04 16:00"

# 表头候选词 → 内部字段名（用 startswith / 全等匹配，容忍 * ^ 等必填标记）
HEADER_KEYS = {
    "productNo": ["产品编号"],
    "name": ["产品名称"],
    "spec": ["规格"],
    "unit": ["销售单位"],
    "qty": ["数量"],
    "unitPrice": ["单价"],
    "discount": ["折扣（%）", "折扣(%)", "折扣"],
    "salePrice": ["售价（元）", "售价"],
    "subtotal": ["售价小计"],
    "lineRemark": ["备注"],
    "contractNo": ["合同编号"],
    "contractName": ["合同名称"],
    "customer": ["客户名称"],
    "signDate": ["签订日期"],
    "status": ["合同状态"],
    "owner": ["负责人"],
}

HEADER_NOISE = {"产品名称", "关联产品^", "关联产品", "产品编号*", "产品编号"}

# canonical 商品：(key, 编号, 名称, 类别, 单位, 别名集合, 备注)
# 「别名」是同一服务在不同年份用过的编码，合并成一条，主编号取最近且成交最多的那个。
SPECS = [
    ("cbam", "TQC-01", "CBAM 填报服务", "CBAM 合规", "个",
     {"TQC-01", "TQC.CBAM", "NAME::CBAM填报"}, "源表里出现过 TQC-01 / TQC.CBAM / 无编号三种记法，已合并"),
    ("cdp", "TQC-12", "CDP 填报与提级技术服务", "CBAM 合规", "项", {"TQC-12"}, ""),
    ("org_cf", "TQC-02", "碳足迹核算核查", "碳核算核查", "个", {"TQC-02"}, ""),
    ("pcf", "TQC.CPTZJHC", "产品碳足迹核查", "碳核算核查", "个", {"TQC.CPTZJHC"}, ""),
    ("ghg_report", "TQC.WSQTBG", "温室气体报告", "碳核算核查", "个", {"TQC.WSQTBG"}, ""),
    ("iscc", "TQC.ISCC", "ISCC 认证咨询服务", "碳核算核查", "个", {"TQC.ISCC"}, ""),
    ("green_cert", "TQC-08", "绿证交易", "碳资产交易", "个", {"TQC-08"},
     "源表「单价」列恒为 200000（脏数据），价格取「售价（元）」"),
    ("carbon_trade", "TQC-09", "碳交易", "碳资产交易", "个", {"TQC-09"},
     "源表「单价」列恒为 200000（脏数据），价格取「售价（元）」"),
    ("pcf_system", "TQC-03", "产品碳数字化系统", "数字化系统", "个", {"TQC-03"}, ""),
    ("energy_system", "TQC-04", "能碳管理数字化系统", "数字化系统", "个", {"TQC-04"}, ""),
    ("carbon_system", "TQC-HIS-03", "碳管理系统", "数字化系统", "项", {"NAME::碳管理系统"},
     "历史合同未填产品编号，系统补号"),
    ("carbon_office", "TQC-HIS-04", "碳中和数字办公产品", "数字化系统", "项", {"NAME::碳中和数字办公产品"},
     "历史合同未填产品编号，系统补号"),
    ("bochuang", "TQC-HIS-05", "博创云小程序系统服务", "数字化系统", "项", {"NAME::博创云小程序系统服务"},
     "历史合同未填产品编号，系统补号"),
    ("zero_factory", "CP.20241016000001", "零碳工厂咨询", "咨询评价", "个", {"CP.20241016000001"}, ""),
    ("green_factory", "TQC-HIS-01", "绿色工厂评价", "咨询评价", "项", {"NAME::绿色工厂评价"},
     "历史合同未填产品编号，系统补号"),
    ("esg", "TQC-06", "ESG 咨询与技术服务", "咨询评价", "个", {"TQC-06"}, ""),
    ("low_carbon", "TQC-07", "绿色低碳咨询服务", "咨询评价", "个", {"TQC-07"}, ""),
    ("eco_value", "TQC-18", "其他生态增值服务", "咨询评价", "项", {"TQC-18"}, ""),
    ("training_double", "TQC-HIS-02", "双碳培训", "培训", "项", {"NAME::双碳培训"},
     "历史合同未填产品编号，系统补号"),
    ("training_custom", "PX-DZ", "培训（定制课）", "培训", "个", {"PX-DZ"}, ""),
    ("training_ai", "TQC-27", "AI 与数字化转型企业培训", "培训", "项", {"TQC-27"}, ""),
]

# 现有演示商品：27 条演示订单还引用它们的 ID，只能下架不能删
DEMO_KEEP = {"AI课", "B端课", "入门课", "C端课"}


def norm(text) -> str:
    return re.sub(r"\s+", "", str(text or ""))


def is_header_noise(name: str, product_no: str) -> bool:
    """表头行会漏进数据里（大表头 / 子表头），按内容特征剔掉"""
    if name in HEADER_NOISE or product_no in HEADER_NOISE:
        return True
    return name.startswith("关联产品") or product_no.startswith("产品编号")


def find_columns(grid: list[list]) -> tuple[dict[str, int], int]:
    """在前 5 行内**跨行合并**表头，返回（字段→列下标, 数据起始行下标）。

    匹配时按关键词长度从长到短，避免「售价」抢走「售价小计」的列。
    """
    pairs = sorted(
        ((len(key), f, key) for f, keys in HEADER_KEYS.items() for key in keys),
        reverse=True,
    )
    mapping: dict[str, int] = {}
    header_rows: list[int] = []
    for r in range(min(5, len(grid))):
        used = set(mapping.values())
        hits = 0
        for _length, field_key, key in pairs:
            if field_key in mapping:
                continue
            for c, cell in enumerate(grid[r]):
                text = norm(cell)
                if not text or c in used:
                    continue
                if text == key or text.startswith(key):
                    mapping[field_key] = c
                    used.add(c)
                    hits += 1
                    break
        if hits:
            header_rows.append(r)
    return mapping, (max(header_rows) + 1 if header_rows else 1)


def money(value) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).replace(",", "").replace("¥", "").strip())
    except ValueError:
        return None


def collect_records() -> list[dict]:
    """把两份表里所有商品明细行拉平成一个列表。"""
    records: list[dict] = []
    for path in SOURCES:
        if not path.exists():
            print(f"[warn] 源文件不存在，跳过：{path}")
            continue
        book = read_workbook(path)
        for sheet in book["sheets"]:
            if sheet["state"] != "visible":
                continue
            grid = to_grid(sheet)
            if not grid:
                continue
            cols, start = find_columns(grid)
            if "name" not in cols or "productNo" not in cols:
                print(f"[skip] {path.name} / {sheet['name']}：没有商品列")
                continue

            contract = {"contractNo": "", "contractName": "", "customer": "", "signDate": "", "status": "", "owner": ""}
            for row in grid[start:]:
                def get(field_name: str):
                    idx = cols.get(field_name)
                    return row[idx] if idx is not None and idx < len(row) else None

                contract_no = norm(get("contractNo"))
                if contract_no:
                    # 同一合同的多个产品行里，合同列只在第一行填写
                    contract = {
                        "contractNo": contract_no,
                        "contractName": norm(get("contractName")),
                        "customer": norm(get("customer")),
                        "signDate": norm(get("signDate")),
                        "status": norm(get("status")),
                        "owner": norm(get("owner")),
                    }

                name = norm(get("name"))
                product_no = norm(get("productNo"))
                if (not name and not product_no) or is_header_noise(name, product_no):
                    continue

                records.append(
                    {
                        "productNo": product_no,
                        "name": name,
                        "unit": norm(get("unit")),
                        "qty": money(get("qty")),
                        "salePrice": money(get("salePrice")),
                        "subtotal": money(get("subtotal")),
                        "source": path.name,
                        **contract,
                    }
                )
    return records


def build(records: list[dict]) -> tuple[list[dict], list[dict]]:
    alias = {a: key for key, _no, _n, _c, _u, aliases, _note in SPECS for a in aliases}
    buckets: dict[str, list[dict]] = defaultdict(list)
    unmapped: list[dict] = []

    for row in records:
        raw_key = row["productNo"] or f"NAME::{row['name']}"
        key = alias.get(raw_key)
        if key:
            buckets[key].append(row)
        else:
            unmapped.append(row)

    items: list[dict] = []
    seq = 5
    for key, code, name, category, unit, _aliases, note in SPECS:
        rows = buckets.get(key) or []
        if not rows:
            continue
        all_prices = sorted(r["salePrice"] for r in rows if r["salePrice"])
        distinct = sorted(set(all_prices))
        qtys = [r["qty"] for r in rows if r["qty"] is not None]
        dated = sorted((r for r in rows if r["signDate"]), key=lambda r: r["signDate"])

        reference = round(statistics.median(all_prices), 2) if all_prices else 0
        trimmed = [p for p in distinct if not (reference and p > reference * 10)] or distinct

        items.append(
            {
                "id": f"PD-2026-{seq:04d}",
                "createdAt": IMPORT_STAMP,
                "productNo": code,
                "name": name,
                "price": reference,
                "category": category,
                "unit": unit,
                "status": "上架",
                "dealCount": len(rows),
                "totalQty": round(sum(qtys), 2) if qtys else 0,
                "priceMin": round(min(trimmed), 2) if trimmed else 0,
                "priceMax": round(max(trimmed), 2) if trimmed else 0,
                "firstDealAt": dated[0]["signDate"] if dated else "",
                "lastDealAt": dated[-1]["signDate"] if dated else "",
                "note": note,
            }
        )
        seq += 1

    items.sort(key=lambda x: (-(x["dealCount"] or 0), x["productNo"]))
    return items, unmapped


def main() -> None:
    records = collect_records()
    items, unmapped = build(records)

    existing = json.loads(TARGET.read_text(encoding="utf-8")) if TARGET.exists() else []
    demo = [
        p for p in existing
        if p.get("name") in DEMO_KEEP or (p.get("productNo", "").startswith("PROD-") and not p.get("category"))
    ]
    for item in demo:
        item["status"] = "下架"
        item.setdefault("category", "演示数据")
        item["note"] = "演示商品，已下架；保留是因为历史订单仍引用其 ID"

    merged = items + demo
    TARGET.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"明细行 {len(records)} 条 → 上架 {len(items)} 个 + 下架演示 {len(demo)} 个")
    if unmapped:
        print(f"[warn] 有 {len(unmapped)} 行没匹配上，检查 SPECS 是否漏了新编码：")
        for row in unmapped[:10]:
            print("   ", row["productNo"] or "(无编号)", row["name"])

    header = f"{'编号':<18}{'名称':<24}{'类别':<10}{'状态':<6}{'参考价':>12}{'区间':>20}{'单数':>5}{'最近成交':>12}"
    print("\n" + header)
    print("-" * len(header))
    for item in merged:
        rng = f"{item.get('priceMin') or 0:g} ~ {item.get('priceMax') or 0:g}"
        print(
            f"{item['productNo']:<18}{item['name']:<24}{item.get('category', ''):<10}"
            f"{item.get('status', ''):<6}{item['price']:>12,.0f}{rng:>20}"
            f"{item.get('dealCount', 0):>5}{item.get('lastDealAt', '') or '—':>12}"
        )


if __name__ == "__main__":
    main()
