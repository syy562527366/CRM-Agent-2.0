"""极简 xlsx 读取器（只用标准库）。

环境里 pip 装不了 openpyxl（沙箱断外网），但 xlsx 本质是 zip + XML，
这里只实现「读值」需要的那一小部分：

- workbook.xml → 工作表清单与顺序（含 r:id → 实际 xml 落点）
- sharedStrings.xml → 共享字符串
- styles.xml → 判断哪些数字其实是日期（numFmtId 内建 14~22 / 45~47，或格式串含 y/m/d）
- sheetN.xml → 单元格值（共享串、内联串、公式缓存值、数字、布尔）

不做样式、合并单元格、图表 —— 只为把数据读出来核对。
"""

from __future__ import annotations

import datetime as _dt
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"

# 内建日期格式（含中文区域常见的 27~36 / 50~58 区间里的日期款）
BUILTIN_DATE_IDS = set(range(14, 23)) | {27, 28, 29, 30, 31, 32, 33, 34, 35, 36} | set(range(45, 48)) | set(range(50, 59))


def _cell_text(node) -> str:
    """<si>/<is> 里可能是单个 <t>，也可能是多段 <r><t>（富文本）"""
    return "".join(t.text or "" for t in node.iter(f"{{{NS['m']}}}t"))


def _shared_strings(zf: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return [_cell_text(si) for si in root.findall("m:si", NS)]


def _date_style_indexes(zf: zipfile.ZipFile) -> set[int]:
    """返回「显示成日期」的 cellXfs 下标集合"""
    try:
        root = ET.fromstring(zf.read("xl/styles.xml"))
    except KeyError:
        return set()

    custom: dict[int, str] = {}
    for fmt in root.iter(f"{{{NS['m']}}}numFmt"):
        custom[int(fmt.get("numFmtId", "0"))] = (fmt.get("formatCode") or "").lower()

    def is_date(num_fmt_id: int, code: str) -> bool:
        if num_fmt_id in BUILTIN_DATE_IDS:
            return True
        # 去掉引号内的字面量（例如 "年"）再判断占位符
        stripped = re.sub(r'"[^"]*"|\[[^\]]*\]', "", code)
        return bool(re.search(r"[ymd]", stripped)) and "%" not in stripped and "0.00" not in stripped

    result: set[int] = set()
    cell_xfs = root.find("m:cellXfs", NS)
    if cell_xfs is None:
        return result
    for index, xf in enumerate(cell_xfs.findall("m:xf", NS)):
        num_fmt_id = int(xf.get("numFmtId", "0"))
        if is_date(num_fmt_id, custom.get(num_fmt_id, "")):
            result.add(index)
    return result


def _excel_date(serial: float) -> str:
    base = _dt.datetime(1899, 12, 30)
    value = base + _dt.timedelta(days=serial)
    if value.hour or value.minute:
        return value.strftime("%Y-%m-%d %H:%M")
    return value.strftime("%Y-%m-%d")


def read_workbook(path: Path) -> dict:
    with zipfile.ZipFile(path) as zf:
        shared = _shared_strings(zf)
        date_styles = _date_style_indexes(zf)

        # r:id → sheet 文件路径
        rels: dict[str, str] = {}
        try:
            rel_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
            for rel in rel_root.findall(f"{PKG_REL}Relationship"):
                target = rel.get("Target") or ""
                if target.startswith("/"):
                    target = target[1:]
                elif not target.startswith("xl/"):
                    target = "xl/" + target.lstrip("./")
                rels[rel.get("Id")] = target
        except KeyError:
            pass

        wb_root = ET.fromstring(zf.read("xl/workbook.xml"))
        sheets = []
        for sheet in wb_root.iter(f"{{{NS['m']}}}sheet"):
            sheets.append(
                {
                    "name": sheet.get("name"),
                    "sheet_id": sheet.get("sheetId"),
                    "state": sheet.get("state") or "visible",
                    "path": rels.get(sheet.get(REL_NS), ""),
                }
            )

        out_sheets = []
        for meta in sheets:
            if not meta["path"]:
                continue
            root = ET.fromstring(zf.read(meta["path"]))
            rows: dict[int, dict[int, object]] = {}
            for row in root.iter(f"{{{NS['m']}}}row"):
                r_index = int(row.get("r", "0"))
                for cell in row.iter(f"{{{NS['m']}}}c"):
                    ref = cell.get("r") or ""
                    match = re.match(r"([A-Z]+)(\d+)", ref)
                    if not match:
                        continue
                    col_letters, row_no = match.group(1), int(match.group(2))
                    col = 0
                    for ch in col_letters:
                        col = col * 26 + (ord(ch) - 64)
                    kind = cell.get("t")
                    style = int(cell.get("s", "0"))
                    v = cell.find("m:v", NS)
                    if kind == "inlineStr":
                        is_node = cell.find("m:is", NS)
                        value = _cell_text(is_node) if is_node is not None else None
                    elif kind == "s" and v is not None:
                        idx = int(v.text or "0")
                        value = shared[idx] if idx < len(shared) else None
                    elif kind == "b" and v is not None:
                        value = v.text == "1"
                    elif v is not None and v.text is not None:
                        text = v.text
                        try:
                            num = float(text)
                        except ValueError:
                            value = text
                        else:
                            if style in date_styles and num > 0:
                                value = _excel_date(num)
                            else:
                                value = int(num) if num.is_integer() else num
                    else:
                        value = None
                    if value not in (None, ""):
                        rows.setdefault(row_no, {})[col] = value
            out_sheets.append({**meta, "rows": rows})
        return {"file": str(path), "sheets": out_sheets}


def to_grid(sheet: dict) -> list[list]:
    rows = sheet["rows"]
    if not rows:
        return []
    max_row = max(rows)
    max_col = max((max(r) for r in rows.values()), default=0)
    return [[rows.get(r, {}).get(c) for c in range(1, max_col + 1)] for r in range(1, max_row + 1)]


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        book = read_workbook(Path(arg))
        print("=" * 78)
        print(book["file"])
        for sheet in book["sheets"]:
            grid = to_grid(sheet)
            print(f"\n-- [{sheet['name']}] {sheet['state']} {len(grid)} 行 x {len(grid[0]) if grid else 0} 列")
            for row in grid[:8]:
                cells = ["" if c is None else str(c)[:26] for c in row]
                print("   | " + " | ".join(cells))
