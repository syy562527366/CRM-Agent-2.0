"""中文友好的切块器。

设计取舍：
- **先按标题分节，再按段落聚合**。中文 FAQ / 技能文档天然以标题组织，
  按固定字数硬切会把「问题」和「答案」切到两个块里，检索时只命中半句。
- **每块都带标题路径**（`产品服务总览 > 碳足迹核算 > 多少钱`）。这行会拼进
  embedding 文本，等于给每块补上它所属的上下文，明显提升短块的召回率。
- **不做块间重叠**。重叠会让同一段话被检索出两次，去重逻辑反而更复杂；
  需要上下文时靠 top_k + 相邻块扩展（`store.search(expand=1)`）。
- **表格单独处理**。Markdown 表格按行切开必须重复表头，否则每行都读不懂。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# 默认值按中文语料调：700 字约等于 3-5 个自然段，检索粒度适中。
DEFAULT_MAX_CHARS = 700
DEFAULT_MIN_CHARS = 120

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*$")
_FENCE = re.compile(r"^\s*```")
# 中文句末标点 + 换行
_SENTENCE = re.compile(r"(?<=[。！？；!?;])\s*")


@dataclass
class Chunk:
    ord: int
    heading: str
    content: str

    @property
    def char_len(self) -> int:
        return len(self.content)


@dataclass
class _Section:
    heading: str
    body: str


def split_markdown(
    text: str,
    max_chars: int = DEFAULT_MAX_CHARS,
    min_chars: int = DEFAULT_MIN_CHARS,
) -> list[Chunk]:
    """把 Markdown 切成带标题路径的块。"""
    sections = _split_by_heading(text or "")
    chunks: list[Chunk] = []
    for sec in sections:
        for piece in _pack(sec.body, max_chars=max_chars, min_chars=min_chars):
            chunks.append(Chunk(ord=len(chunks), heading=sec.heading, content=piece))
    return chunks


def split_plain_text(
    text: str,
    max_chars: int = DEFAULT_MAX_CHARS,
    min_chars: int = DEFAULT_MIN_CHARS,
) -> list[Chunk]:
    """纯文本（无 Markdown 结构）切块，整篇视为一个无标题的节。"""
    body = (text or "").strip()
    if not body:
        return []
    return [
        Chunk(ord=i, heading="", content=piece)
        for i, piece in enumerate(_pack(body, max_chars, min_chars))
    ]


def embed_text(title: str, heading: str, content: str) -> str:
    """拼出送进 embedding 的文本：标题路径 + 正文。

    只影响向量，落库的 `content` 仍是原文，前端展示不会被这行前缀污染。
    """
    parts = [p for p in (title.strip(), heading.strip()) if p]
    prefix = " > ".join(parts)
    return f"{prefix}\n{content}" if prefix else content


# --------------------------------------------------------------------------- #
# 内部实现
# --------------------------------------------------------------------------- #


def _split_by_heading(text: str) -> list[_Section]:
    """按 # / ## / ### 分节，维护标题栈生成完整路径。

    代码围栏里的 `#` 是注释，不能被当成标题 —— 用 fence 状态机跳过。
    """
    sections: list[_Section] = []
    stack: list[tuple[int, str]] = []
    buf: list[str] = []
    in_fence = False

    def flush() -> None:
        body = "\n".join(buf).strip()
        if body:
            sections.append(_Section(heading=" > ".join(t for _, t in stack), body=body))
        buf.clear()

    for line in (text or "").splitlines():
        if _FENCE.match(line):
            in_fence = not in_fence
            buf.append(line)
            continue
        if in_fence:
            buf.append(line)
            continue

        m = _HEADING.match(line)
        if m:
            flush()
            level = len(m.group(1))
            title = m.group(2).strip()
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
            continue
        buf.append(line)

    flush()
    if not sections:
        body = (text or "").strip()
        if body:
            sections.append(_Section(heading="", body=body))
    return sections


def _pack(body: str, max_chars: int, min_chars: int) -> list[str]:
    """把一节正文按段落聚合成不超过 max_chars 的块。"""
    body = (body or "").strip()
    if not body:
        return []
    if len(body) <= max_chars:
        return [body]

    blocks = _blocks(body)
    out: list[str] = []
    cur: list[str] = []
    size = 0

    for blk in blocks:
        blen = len(blk)
        if blen > max_chars:
            # 单块就超限：先把已攒的吐出去，再把长块按句子切
            if cur:
                out.append("\n\n".join(cur))
                cur, size = [], 0
            out.extend(_split_long(blk, max_chars))
            continue
        if size + blen + 2 > max_chars and cur:
            out.append("\n\n".join(cur))
            cur, size = [], 0
        cur.append(blk)
        size += blen + 2

    if cur:
        out.append("\n\n".join(cur))

    # 收尾处理：末尾过短的块并入上一块，避免出现只有一句的碎片
    if len(out) > 1 and len(out[-1]) < min_chars:
        merged = out[-2] + "\n\n" + out[-1]
        if len(merged) <= max_chars * 1.25:
            out[-2:] = [merged]

    return [c for c in out if c.strip()]


def _blocks(body: str) -> list[str]:
    """段落 + 表格 + 代码围栏作为不可再分的整体块。

    表格必须整块保留（切开就丢表头），代码块同理。
    """
    blocks: list[str] = []
    cur: list[str] = []
    in_fence = False
    in_table = False

    def flush() -> None:
        text = "\n".join(cur).strip()
        if text:
            blocks.append(text)
        cur.clear()

    for line in body.splitlines():
        stripped = line.strip()

        if _FENCE.match(stripped):
            if not in_fence:
                flush()
            in_fence = not in_fence
            cur.append(line)
            if not in_fence:
                flush()
            continue

        if in_fence:
            cur.append(line)
            continue

        is_table = stripped.startswith("|")
        if is_table != in_table:
            flush()
            in_table = is_table

        if not stripped:
            if in_table:
                continue  # 表格内的空行跳过，保持表格完整
            flush()
            continue

        cur.append(line)

    flush()
    return blocks


def _split_long(block: str, max_chars: int) -> list[str]:
    """超长单块按句子切，句子仍超长时硬切。"""
    sentences = [s for s in _SENTENCE.split(block) if s.strip()]
    out: list[str] = []
    cur = ""
    for sent in sentences:
        if len(sent) > max_chars:
            if cur:
                out.append(cur)
                cur = ""
            for i in range(0, len(sent), max_chars):
                out.append(sent[i : i + max_chars])
            continue
        if len(cur) + len(sent) > max_chars and cur:
            out.append(cur)
            cur = sent
        else:
            cur += sent
    if cur:
        out.append(cur)
    return [c for c in out if c.strip()]
