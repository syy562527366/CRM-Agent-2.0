"""知识库检索工具。

数据源是本地 `agent/data/kb.sqlite3`（sqlite-vec + 硅基流动 Qwen3-Embedding）。
与 `tools_crm.py` 的区别：那边查的是**实时业务数据**（线索、订单），
这边查的是**静态资料**（产品服务 FAQ、技能文档、项目说明）。

为什么不走 HTTP：知识库是本进程独占的本地文件，没有远端服务，
直接读 SQLite 比绕一层 HTTP 更快，也不需要额外开端口。
"""

from __future__ import annotations

import threading
from typing import Any

from langchain_core.tools import tool

from crm_client import dump, fail, ok
from kb.config import load_config
from kb.embedding import Embedder, get_embedder
from kb.store import KBStore

# SQLite 连接不能跨线程共享（check_same_thread 默认 True，也不该关掉）。
# FastAPI 的同步接口跑在线程池里，所以按线程各存一份。
_local = threading.local()

# 单条命中回给模型的正文上限。检索是为了「定位到哪一段」，
# 不是把整篇文档塞进上下文；600 字约等于 2-3 段，够模型判断相关性。
_MAX_CONTENT_CHARS = 600

_ALLOWED_TYPES = {"faq", "product", "skill", "doc", "file"}


def _store() -> KBStore:
    store = getattr(_local, "store", None)
    if store is None:
        store = KBStore(load_config())
        _local.store = store
    return store


def _embedder() -> Embedder:
    embedder = getattr(_local, "embedder", None)
    if embedder is None:
        embedder = get_embedder()
        _local.embedder = embedder
    return embedder


@tool
def kb_search(query: str, top_k: int = 5, doc_type: str = "") -> str:
    """在本地知识库中检索资料。用于回答「产品服务怎么收费 / 适合谁 / 交付什么」
    「公司有哪些服务」「某项技能该怎么做」这类**资料型**问题。

    不要用它查实时业务数据（线索、订单、客户情况）——那要用 crm_* 工具。
    也可以先用它确认产品口径，再用 crm_* 取数。

    问产品服务本身（计价 / 适用客户 / 交付 / 服务内容 / 采购流程）时，
    **请显式传 doc_type="faq"**：库里还混着技能说明和项目文档，不过滤会把
    「技能该怎么写」这类内容当成产品资料返回。

    Args:
        query: 检索语句，用自然语言描述想找的内容，例如「CBAM 填报怎么收费」。
        top_k: 返回条数，默认 5，最大 10。一次问多个产品时给 8。
        doc_type: 可选，限定资料类型：faq（产品常见问题）/ product（产品信息）/
            skill（技能说明）/ doc（项目文档）/ file（人工上传的知识库文件）。
            留空表示全部 —— 问业务资料但不确定归属时留空更稳。
    """
    text = (query or "").strip()
    if not text:
        return dump(fail("INVALID_ARGUMENT", "请提供检索内容，例如「产品碳足迹核算怎么收费」"))

    try:
        limit = int(top_k)
    except (TypeError, ValueError):
        limit = 5
    limit = max(1, min(limit, 10))

    dtype = (doc_type or "").strip().lower()
    if dtype and dtype not in _ALLOWED_TYPES:
        return dump(
            fail(
                "INVALID_ARGUMENT",
                f"doc_type 只能是 {' / '.join(sorted(_ALLOWED_TYPES))}，或留空",
            )
        )

    try:
        store = _store()
    except RuntimeError as exc:
        return dump(fail("KB_NOT_READY", f"知识库不可用：{exc}"))

    try:
        vector = _embedder().embed_query(text)
        hits = store.search(
            vector,
            top_k=limit,
            doc_type=dtype or None,
            query_text=text,
        )
    except Exception as exc:  # noqa: BLE001 - 工具层统一转成可读文本
        return dump(fail("KB_SEARCH_FAILED", f"检索失败：{type(exc).__name__}: {exc}"))

    if not hits:
        return dump(
            ok(
                query=text,
                hits=[],
                note="知识库中没有找到相关内容。可以换个说法再检索，或直接告知用户暂无该资料。",
            )
        )

    rows: list[dict[str, Any]] = []
    for i, hit in enumerate(hits, 1):
        body = hit.content.strip()
        if len(body) > _MAX_CONTENT_CHARS:
            body = body[:_MAX_CONTENT_CHARS] + "…"
        rows.append(
            {
                "rank": i,
                "score": round(hit.score, 3),
                "title": hit.title,
                "section": hit.heading,
                "source": hit.source,
                "doc_type": hit.doc_type,
                "content": body,
            }
        )

    return dump(
        ok(
            query=text,
            count=len(rows),
            hits=rows,
            note=(
                "以上是知识库原文片段。引用时以 content 为准，不要补写资料里没有的数字；"
                "同一事件在多个片段重复出现时只取最相关的一条。"
            ),
        )
    )


KB_TOOLS = [kb_search]
