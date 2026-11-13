"""上传文件 → RawDoc。

支持三类来源：
    文本  .md / .markdown / .txt       按 Markdown 结构切块
    表格  .csv                        首行作表头，逐行渲染成「列名：值」
    表格  .xlsx / .xlsm               每个sheet 一篇文档，规则同上

为什么表格要「逐行 → 列名：值」而不是整张 Markdown 表：
向量模型看到 `| 30,000~40,000 | 咨询评价 |` 完全不知道这两列是什么，
补一行表头也只能覆盖表头本身。把列名并进每一行，等于让每行自带语义，
检索「碳足迹核算多少钱」时才能命中「参考价格：30,000~40,000」这一行。

上传文件与内置语料（FAQ / 技能 / 文档）走同一条入库路径，
所以删除、检索、幂等规则完全一致，doc_type 固定为 `file`。
"""

from __future__ import annotations

import csv
import io
import re
from pathlib import Path

from kb.loader import RawDoc, _first_heading, parse_frontmatter

# 单个文件 20 MB：FAQ 那种 CSV 只有 56 KB，纯文本知识库到不了这个量级，
# 超过基本是误传了大表或压缩包改后缀。
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

# 单次上传的总正文上限。embedding 按字符计费，40 万字约等于 1000+ 块、
# 30+ 次请求，交互式上传已经到顶了；再大应该拆成多个文件上传。
MAX_TOTAL_CHARS = 400_000

# 单表最多导入的行数。超出部分截断并在正文里写明，
# 不做静默丢弃 —— 用户需要知道「只进去了前 2000 行」。
MAX_TABLE_ROWS = 2000

TEXT_EXT = {".md", ".markdown", ".txt"}
TABLE_EXT = {".csv", ".xlsx", ".xlsm", ".xls"}
ALLOWED_EXT = TEXT_EXT | TABLE_EXT

_SAFE_NAME = re.compile(r"[^\w\u4e00-\u9fff.\-()（）\s]")


class UploadError(ValueError):
    """上传文件无法处理，message 直接展示给用户。"""


def normalize_filename(raw: str) -> str:
    """只取文件名部分，去掉路径与控制字符。

    浏览器发来的 filename 理论上就是文件名，但这是外部输入：
    带 `../` 或 `C:\\` 时若参与落盘/展示，容易变成路径穿越或误导。
    我们不落盘（内容直接进 SQLite），仍然统一清洗，避免脏名字进列表。
    """
    name = (raw or "").replace("\\", "/").split("/")[-1].strip()
    name = _SAFE_NAME.sub("", name).strip(" .")
    if not name:
        raise UploadError("文件名无效，请重命名后再上传")
    return name[:120]


def check_ext(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise UploadError(
            f"不支持的文件类型 {ext or '（无扩展名）'}，"
            "目前支持 .md / .txt / .csv / .xlsx"
        )
    return ext


def decode_text(data: bytes) -> str:
    """按 UTF-8 → GB18030 顺序解码。

    Windows 上另存的 CSV / TXT 大量是 GBK 编码，只按 UTF-8 读会得到一堆
    替换符，切出来的块等于噪声；GB18030 是 GBK 的超集，兜得住。
    """
    for enc in ("utf-8-sig", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def parse_upload(filename: str, data: bytes) -> list[RawDoc]:
    """把上传的字节流解析成待入库文档。"""
    name = normalize_filename(filename)
    if not data:
        raise UploadError("文件是空的")
    if len(data) > MAX_UPLOAD_BYTES:
        raise UploadError(
            f"文件超过 {MAX_UPLOAD_BYTES // 1024 // 1024} MB 上限（当前 "
            f"{len(data) / 1024 / 1024:.1f} MB），请拆分后再上传"
        )

    ext = check_ext(name)
    stem = Path(name).stem

    if ext in TEXT_EXT:
        docs = [_text_doc(name, stem, decode_text(data), ext)]
    elif ext == ".csv":
        docs = [_csv_doc(name, stem, decode_text(data))]
    elif ext == ".xls":
        raise UploadError("旧版 .xls 无法解析，请在 Excel 中另存为 .xlsx 后重试")
    else:
        docs = _xlsx_docs(name, stem, data)

    docs = [d for d in docs if d.text.strip()]
    if not docs:
        raise UploadError("没有解析到可用内容（文件为空，或表格只有表头）")

    total = sum(len(d.text) for d in docs)
    if total > MAX_TOTAL_CHARS:
        raise UploadError(
            f"解析出 {total:,} 字，超过单次 {MAX_TOTAL_CHARS:,} 字上限，"
            "请拆分成多个文件上传"
        )
    return docs


# --------------------------------------------------------------------------- #
# 文本
# --------------------------------------------------------------------------- #


def _text_doc(name: str, stem: str, text: str, ext: str) -> RawDoc:
    body = text
    meta: dict[str, object] = {"filename": name, "ext": ext}
    if ext in {".md", ".markdown"}:
        fm, body = parse_frontmatter(text)
        meta.update({k: v for k, v in fm.items() if k not in {"name", "title"}})

    body = body.strip()
    if not body:
        raise UploadError("文件内容是空的")

    title = str(meta.get("title") or meta.get("name") or "").strip()
    title = title or _first_heading(body) or stem
    return RawDoc(
        doc_key=f"file:{stem}",
        title=title.strip()[:80],
        source=f"上传/{name}",
        doc_type="file",
        text=body,
        meta=meta,
    )


# --------------------------------------------------------------------------- #
# 表格
# --------------------------------------------------------------------------- #


def _csv_doc(name: str, stem: str, text: str) -> RawDoc:
    rows = [r for r in csv.reader(io.StringIO(text)) if any((c or "").strip() for c in r)]
    if not rows:
        raise UploadError("CSV 没有内容")
    header = [(c or "").strip() or f"列{i + 1}" for i, c in enumerate(rows[0])]
    body = _rows_markdown(header, rows[1:], total=len(rows) - 1)
    return RawDoc(
        doc_key=f"file:{stem}",
        title=stem,
        source=f"上传/{name}",
        doc_type="file",
        text=f"# {stem}\n\n## 数据表\n\n{body}".strip(),
        meta={"filename": name, "ext": ".csv", "rows": len(rows) - 1, "columns": len(header)},
    )


def _xlsx_docs(name: str, stem: str, data: bytes) -> list[RawDoc]:
    try:
        from openpyxl import load_workbook
    except ImportError as exc:  # pragma: no cover - 依赖已装，兜底提示
        raise UploadError("服务端缺少 openpyxl，无法解析 Excel") from exc

    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as exc:  # noqa: BLE001 - 损坏文件 / 加密文件都归到这里
        raise UploadError(f"Excel 解析失败：{type(exc).__name__}: {exc}"[:160]) from exc

    out: list[RawDoc] = []
    multi = len(wb.sheetnames) > 1
    for sheet in wb.worksheets:
        rows = [
            ["" if c is None else str(c).strip() for c in row]
            for row in sheet.iter_rows(values_only=True)
        ]
        rows = [r for r in rows if any(c for c in r)]
        if len(rows) < 2:
            continue  # 只有表头或空表，没有可检索内容

        header = [c or f"列{i + 1}" for i, c in enumerate(rows[0])]
        body = _rows_markdown(header, rows[1:], total=len(rows) - 1)
        title = f"{stem}（{sheet.title}）" if multi else stem
        out.append(
            RawDoc(
                doc_key=f"file:{stem}#{sheet.title}" if multi else f"file:{stem}",
                title=title[:80],
                source=f"上传/{name}",
                doc_type="file",
                text=f"# {title}\n\n## {sheet.title}\n\n{body}".strip(),
                meta={
                    "filename": name,
                    "ext": ".xlsx",
                    "sheet": sheet.title,
                    "rows": len(rows) - 1,
                    "columns": len(header),
                },
            )
        )
    wb.close()
    return out


def _rows_markdown(header: list[str], rows: list[list[str]], total: int) -> str:
    """每行渲染成「列名：值」并用空行分隔。

    空行分隔是必须的：切块器按段落聚合，粘成一整块后会被按「；」硬切，
    一行数据可能被劈成两个块，检索时只命中半行。
    """
    kept = rows[:MAX_TABLE_ROWS]
    lines: list[str] = []
    if total > len(kept):
        lines.append(f"> 本表共 {total} 行，已导入前 {len(kept)} 行。")
        lines.append("")

    for idx, row in enumerate(kept, 1):
        pairs = [
            f"{header[i]}：{value}"
            for i, value in enumerate(row)
            if i < len(header) and value.strip()
        ]
        if not pairs:
            continue
        lines.append(f"- 第 {idx} 行｜" + "；".join(pairs))
        lines.append("")

    body = "\n".join(lines).strip()
    if not body:
        raise UploadError("表格里没有有效数据行")
    return body
