"""语料加载：把不同来源的文档统一成 RawDoc，交给切块与入库。

支持的来源：
    技能      agent/skills/*/SKILL.md        每技能一篇
    项目文档  docs/*.md、README.md           每文件一篇
    产品 FAQ  产品服务FAQ.xlsx               按产品分组，每产品一篇
    通用 FAQ  产品服务FAQ.xlsx               整表一篇

为什么要按产品分文档而不是整张表一篇：doc_key 是幂等键，
按产品分才能做到「只改了一个产品的 FAQ 就只重算这一个产品的向量」，
整表一篇的话改一个字就要重算 130 多个切块。
"""

from __future__ import annotations

import csv
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

PROJECT_ROOT = Path(__file__).resolve().parents[2]  # crm-agent-1.0/
AGENT_DIR = Path(__file__).resolve().parents[1]


@dataclass
class RawDoc:
    doc_key: str
    title: str
    source: str
    doc_type: str
    text: str
    meta: dict[str, Any] = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Markdown
# --------------------------------------------------------------------------- #

_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.S)


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """拆出 YAML frontmatter。

    只解析 `key: value` 这种单层结构，够用且不引入 pyyaml 依赖。
    """
    m = _FRONTMATTER.match(text or "")
    if not m:
        return {}, text or ""
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip().strip("'\"")
    return meta, text[m.end() :]


def from_markdown_file(path: Path, doc_type: str) -> RawDoc:
    raw = path.read_text(encoding="utf-8", errors="replace")
    fm, body = parse_frontmatter(raw)
    title = fm.get("name") or fm.get("title") or _first_heading(body) or path.stem
    return RawDoc(
        doc_key=f"{doc_type}:{path.parent.name if doc_type == 'skill' else path.stem}",
        title=title,
        source=_rel(path),
        doc_type=doc_type,
        text=body,
        meta={k: v for k, v in fm.items() if k not in {"name", "title"}},
    )


def _first_heading(text: str) -> str:
    for line in (text or "").splitlines():
        m = re.match(r"^#{1,3}\s+(.+)$", line.strip())
        if m:
            return m.group(1).strip()
    return ""


def load_skills(skills_dir: Path | None = None) -> list[RawDoc]:
    """技能文档。目录名即技能名，与 skills_store 的校验规则一致。"""
    root = skills_dir or (AGENT_DIR / "skills")
    out: list[RawDoc] = []
    if not root.exists():
        return out
    for skill in sorted(root.iterdir()):
        if not skill.is_dir() or skill.name.startswith((".", "_")):
            continue
        md = skill / "SKILL.md"
        if not md.exists():
            continue
        doc = from_markdown_file(md, "skill")
        doc.doc_key = f"skill:{skill.name}"
        doc.meta["skill_name"] = skill.name
        out.append(doc)
    return out


def load_markdown_dir(root: Path, doc_type: str = "doc") -> list[RawDoc]:
    out: list[RawDoc] = []
    if not root.exists():
        return out
    for path in sorted(root.rglob("*.md")):
        if any(part.startswith((".", "_", "node_modules")) for part in path.parts):
            continue
        out.append(from_markdown_file(path, doc_type))
    return out


def load_single_markdown(path: Path, doc_type: str = "doc") -> list[RawDoc]:
    if not path.exists():
        return []
    return [from_markdown_file(path, doc_type)]


# --------------------------------------------------------------------------- #
# Excel（产品服务 FAQ）
# --------------------------------------------------------------------------- #


def _read_sheet(ws) -> tuple[list[str], list[list[str]]]:
    """定位表头行（含「序号」的那一行），返回表头与数据行。

    这张表的第 1 行是标题横幅，真正表头在第 2 行，
    写死行号遇到调整就会错位，所以按内容找。
    """
    header_row = 1
    for r in range(1, min(ws.max_row, 8) + 1):
        values = [str(ws.cell(row=r, column=c).value or "") for c in range(1, ws.max_column + 1)]
        if "序号" in values:
            header_row = r
            break

    headers = [
        str(ws.cell(row=header_row, column=c).value or "").strip()
        for c in range(1, ws.max_column + 1)
    ]
    rows: list[list[str]] = []
    for r in range(header_row + 1, ws.max_row + 1):
        vals = [str(ws.cell(row=r, column=c).value or "").strip() for c in range(1, ws.max_column + 1)]
        if not any(vals):
            continue
        # 合计行不是数据
        if vals[0] in {"合计", "总计"} or "合计" in vals[:2]:
            continue
        rows.append(vals)
    return headers, rows


def load_faq_xlsx(path: Path) -> list[RawDoc]:
    """产品服务 FAQ：按产品聚合，通用 FAQ 单独一篇，产品总览逐行一篇。"""
    try:
        import openpyxl
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("读取 xlsx 需要 openpyxl：pip install openpyxl") from exc

    if not path.exists():
        return []

    wb = openpyxl.load_workbook(path, data_only=True)
    out: list[RawDoc] = []

    # ---- 每产品四问 ----
    if "产品服务 FAQ" in wb.sheetnames:
        headers, rows = _read_sheet(wb["产品服务 FAQ"])
        idx = {h: i for i, h in enumerate(headers)}
        get = lambda row, key: row[idx[key]] if key in idx and idx[key] < len(row) else ""

        grouped: dict[str, list[list[str]]] = {}
        for row in rows:
            name = get(row, "产品名称")
            if name:
                grouped.setdefault(name, []).append(row)

        for name, items in grouped.items():
            category = get(items[0], "所属类别")
            # 类别写进标题而不是独立一行：否则会切出一个只有
            # "所属类别：碳核算核查" 的碎片块（9 个字），向量信号极弱
            heading = f"# {name}（{category}）" if category else f"# {name}"
            lines = [heading, ""]
            for row in items:
                q = get(row, "问题")
                a = get(row, "答案")
                if not q:
                    continue
                lines += [f"## {q}", "", a, ""]
            out.append(
                RawDoc(
                    doc_key=f"faq:product:{name}",
                    title=f"{name} 常见问题",
                    source=_rel(path),
                    doc_type="faq",
                    text="\n".join(lines).strip(),
                    meta={"product": name, "category": category, "questions": len(items)},
                )
            )

    # ---- 通用 FAQ ----
    if "通用 FAQ" in wb.sheetnames:
        headers, rows = _read_sheet(wb["通用 FAQ"])
        idx = {h: i for i, h in enumerate(headers)}
        get = lambda row, key: row[idx[key]] if key in idx and idx[key] < len(row) else ""

        lines = ["# 通用采购与交付 FAQ", ""]
        for row in rows:
            q, a = get(row, "问题"), get(row, "答案")
            if not q:
                continue
            category = get(row, "分类")
            if category:
                lines += [f"分类：{category}"]
            lines += [f"## {q}", "", a, ""]
        if len(lines) > 2:
            out.append(
                RawDoc(
                    doc_key="faq:general",
                    title="通用采购与交付 FAQ",
                    source=_rel(path),
                    doc_type="faq",
                    text="\n".join(lines).strip(),
                    meta={"scope": "general", "questions": len(rows)},
                )
            )

    # ---- 产品总览（每个产品一段字段清单）----
    if "产品服务总览" in wb.sheetnames:
        headers, rows = _read_sheet(wb["产品服务总览"])
        idx = {h: i for i, h in enumerate(headers)}
        get = lambda row, key: row[idx[key]] if key in idx and idx[key] < len(row) else ""

        for row in rows:
            name = get(row, "产品名称")
            if not name:
                continue
            fields = [
                ("产品编号", "产品编号"),
                ("所属类别", "所属类别"),
                ("计价单位", "计价单位"),
                ("参考单价(元)", "参考单价(元)"),
                ("价格区间(元)", "价格区间(元)"),
                ("累计成交(次)", "累计成交(次)"),
                ("累计数量", "累计数量"),
                ("最近成交", "最近成交"),
                ("一句话定位", "一句话定位"),
                ("主要适合客户", "主要适合客户"),
            ]
            lines = [f"# {name}", ""]
            for label, key in fields:
                value = get(row, key)
                if value and value not in {"-", "—"}:
                    lines.append(f"- {label}：{value}")
            out.append(
                RawDoc(
                    doc_key=f"overview:product:{name}",
                    title=f"{name} 产品信息",
                    source=_rel(path),
                    doc_type="product",
                    text="\n".join(lines).strip(),
                    meta={"product": name, "category": get(row, "所属类别")},
                )
            )

    return out


# --------------------------------------------------------------------------- #
# CSV（产品 FAQ 1.0）
# --------------------------------------------------------------------------- #

FAQ_CSV_NAME = "产品FAQ-1.0.csv"

# 只在「有数字但没有任何单位」时补元，例如 `30,000 ~ 40,000`、`统一 100,000`。
# 带单位或说明的原样保留，否则会出现「0.3 ~ 7.8 元 / 张 元」「历史合同未记录 元」
# 这类硬拼出来的错句；`按份计价` 这种没有数字的也不补。
_PRICE_DIGIT = re.compile(r"\d")
_PRICE_UNIT = re.compile(r"[元万亿]")


def _price_line(raw: str) -> str:
    price = (raw or "").strip()
    if not price or price in {"-", "—"}:
        return ""
    if _PRICE_DIGIT.search(price) and not _PRICE_UNIT.search(price):
        return f"参考价格：{price} 元"
    return f"参考价格：{price}"


def load_faq_csv(path: Path) -> list[RawDoc]:
    """产品 FAQ CSV：每产品一篇、每问一节，通用问答单独一篇。

    列结构与 xlsx 版一脉相承（问题/答案/问题类型/参考价格都是现成的），
    所以 doc_key 沿用 `faq:product:<产品名>`：从 xlsx 换到 csv 是**替换**，
    不会在库里留下两份同一产品的 FAQ。

    问题类型写进小节标题（`计价方式：怎么计价收费？`）而不是正文首行——
    标题会拼进 embedding 前缀，等于免费给每块补了一层语义标签。
    """
    if not path.exists():
        return []

    grouped: dict[str, list[dict[str, str]]] = {}
    general: list[dict[str, str]] = []

    with path.open(encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            name = (row.get("产品名称") or "").strip()
            if not name:
                continue
            if (row.get("记录类型") or "").strip() == "通用FAQ" or name.startswith("通用"):
                general.append(row)
            else:
                grouped.setdefault(name, []).append(row)

    out: list[RawDoc] = []
    for name, rows in grouped.items():
        category = (rows[0].get("所属类别") or "").strip()
        code = (rows[0].get("产品编号") or "").strip()
        # 编号并入 H1 而不是单独一行：单独一行会切出一个只有
        # 「产品编号：CP.xxx」的碎片块，向量信号几乎为零。
        # H1 会进入每个块的标题路径，等于让编号伴随所有问题块。
        tags = "，".join(p for p in (category, f"编号 {code}" if code else "") if p)
        lines = [f"# {name}（{tags}）" if tags else f"# {name}", ""]
        for row in rows:
            q = (row.get("问题") or "").strip()
            if not q:
                continue
            kind = (row.get("问题类型") or "").strip()
            lines += [f"## {kind}：{q}" if kind else f"## {q}", ""]
            answer = (row.get("答案") or "").strip()
            if answer:
                lines += [answer, ""]
            price = _price_line(row.get("参考价格") or "")
            if price:
                lines += [price, ""]
        out.append(
            RawDoc(
                doc_key=f"faq:product:{name}",
                title=f"{name} 常见问题",
                source=_rel(path),
                doc_type="faq",
                text="\n".join(lines).strip(),
                meta={
                    "product": name,
                    "product_code": code,
                    "category": category,
                    "questions": len(rows),
                    "faq_id": (rows[0].get("faq_id") or "").strip(),
                },
            )
        )

    if general:
        lines = ["# 通用采购与交付 FAQ", ""]
        for row in general:
            q = (row.get("问题") or "").strip()
            if not q:
                continue
            kind = (row.get("问题类型") or "").strip()
            lines += [f"## {kind}：{q}" if kind else f"## {q}", ""]
            answer = (row.get("答案") or "").strip()
            if answer:
                lines += [answer, ""]
            price = _price_line(row.get("参考价格") or "")
            if price:
                lines += [price, ""]
        out.append(
            RawDoc(
                doc_key="faq:general",
                title="通用采购与交付 FAQ",
                source=_rel(path),
                doc_type="faq",
                text="\n".join(lines).strip(),
                meta={"scope": "general", "questions": len(general)},
            )
        )

    return out


# --------------------------------------------------------------------------- #
# 聚合
# --------------------------------------------------------------------------- #


def default_corpus(faq_xlsx: Path | None = None, faq_csv: Path | None = None) -> list[RawDoc]:
    """默认语料 = 技能 + 项目文档 + 产品 FAQ。

    还没纳入：CRM 线索与沟通记录。那部分按客户维度隔离、涉及权限，
    需要先定「谁能检索谁的线索」，否则等于把脱敏规则绕过一遍。
    """
    docs: list[RawDoc] = []
    docs += load_skills()
    docs += load_markdown_dir(AGENT_DIR / "docs", "doc")
    docs += load_single_markdown(AGENT_DIR / "README.md", "doc")
    docs += load_single_markdown(PROJECT_ROOT / "README.md", "doc")

    # FAQ 语料优先用 CSV 版：它是人工整理过的定稿，xlsx 只是它的导出物
    csv_path = faq_csv or (PROJECT_ROOT.parent / FAQ_CSV_NAME)
    if csv_path.exists():
        docs += load_faq_csv(csv_path)
    else:
        docs += load_faq_xlsx(faq_xlsx or (PROJECT_ROOT.parent / "产品服务FAQ.xlsx"))

    # 同一 doc_key 只保留最后一个（后加载的覆盖先加载的）
    deduped: dict[str, RawDoc] = {}
    for doc in docs:
        if doc.text.strip():
            deduped[doc.doc_key] = doc
    return list(deduped.values())


def _rel(path: Path) -> str:
    for base in (PROJECT_ROOT, PROJECT_ROOT.parent):
        try:
            return str(path.relative_to(base)).replace("\\", "/")
        except ValueError:
            continue
    return path.name
