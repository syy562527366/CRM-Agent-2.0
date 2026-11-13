"""上传任务的进度状态机 + 后台执行。

状态放内存而不是 SQLite，是有意的：
进度是「一次性任务」的临时状态，任务结束即失去意义；进程重启后正在跑的任务
本来也已经中断，若落盘反而会留下一条永远 `processing` 的假记录。
**文档是否真的入库，以 kb_docs 为准** —— 那才是唯一事实来源。

上传任务串行执行（`_worker_lock`）：embedding 是同步阻塞调用，
并发上传只会让两条进度互相打断，还会争 SQLite 写锁。排队中的任务保持
`queued` 状态，前端能明确显示「排队中」而不是假装在跑。
"""

from __future__ import annotations

import threading
import time
import uuid
from typing import Any, Callable

from kb.chunker import embed_text, split_markdown
from kb.config import load_config
from kb.embedding import get_embedder
from kb.store import KBStore
from kb.upload import parse_upload

# 正在处理的状态；前端据此决定是否继续轮询
RUNNING = {"queued", "parsing", "chunking", "embedding", "indexing"}

_KEEP = 20  # 内存里最多留 20 条任务记录

_jobs: dict[str, dict[str, Any]] = {}
_order: list[str] = []
_lock = threading.Lock()
_worker_lock = threading.Lock()


def get_job(job_id: str) -> dict[str, Any] | None:
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def list_jobs(limit: int = 20) -> list[dict[str, Any]]:
    with _lock:
        ids = list(reversed(_order))[:limit]
        return [dict(_jobs[i]) for i in ids if i in _jobs]


def has_running() -> bool:
    with _lock:
        return any(j["status"] in RUNNING for j in _jobs.values())


def forget_document(doc_id: int) -> None:
    """文档被删除后，把引用它的任务记录一并摘掉。

    任务卡是「刚才上传成功」的凭据。文档被删了卡片还挂着，看的人会以为
    删除没生效 —— 服务端记住这层关联，比前端猜标题靠谱。
    """
    with _lock:
        for job_id in list(_order):
            job = _jobs.get(job_id)
            if job and doc_id in job.get("doc_ids", []):
                _jobs.pop(job_id, None)
                _order.remove(job_id)


def _update(job_id: str, **fields: Any) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        job.update(fields)
        job["updated_at"] = _now()


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def submit(filename: str, data: bytes, on_done: Callable[[], None] | None = None) -> dict[str, Any]:
    """建任务并异步执行，立即返回任务快照。"""
    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "filename": filename,
        "status": "queued",
        "stage": "排队中",
        "progress": 0,
        "docs": 0,
        "chunks": 0,
        "chars": 0,
        "error": "",
        "titles": [],
        "doc_ids": [],
        "created_at": _now(),
        "updated_at": _now(),
        "finished_at": "",
    }
    with _lock:
        _jobs[job_id] = job
        _order.append(job_id)
        while len(_order) > _KEEP:
            _jobs.pop(_order.pop(0), None)
        snapshot = dict(job)

    thread = threading.Thread(
        target=_run,
        args=(job_id, filename, data, on_done),
        name=f"kb-upload-{job_id}",
        daemon=True,
    )
    thread.start()
    return snapshot


def _run(
    job_id: str,
    filename: str,
    data: bytes,
    on_done: Callable[[], None] | None,
) -> None:
    try:
        # 排队等待上一个任务结束，避免并发写库
        with _worker_lock:
            _execute(job_id, filename, data)
    except Exception as exc:  # noqa: BLE001 - 任何异常都要落到任务状态里给用户看
        _update(
            job_id,
            status="failed",
            stage="处理失败",
            error=f"{type(exc).__name__}: {exc}"[:300],
            finished_at=_now(),
        )
    finally:
        if on_done is not None:
            try:
                on_done()
            except Exception:  # noqa: BLE001 - 回调失败不影响任务结果
                pass


def _execute(job_id: str, filename: str, data: bytes) -> None:
    _update(job_id, status="parsing", stage="解析文件", progress=6)
    docs = parse_upload(filename, data)

    _update(job_id, status="chunking", stage="切块", progress=15, docs=len(docs), titles=[d.title for d in docs])
    prepared: list[tuple[Any, list[Any]]] = []
    for doc in docs:
        chunks = split_markdown(doc.text)
        if chunks:
            prepared.append((doc, chunks))
    if not prepared:
        raise RuntimeError("没有解析到可用切块（内容可能只有一行标题）")

    total_chunks = sum(len(c) for _, c in prepared)
    total_chars = sum(sum(len(ch.content) for ch in c) for _, c in prepared)
    _update(
        job_id,
        status="embedding",
        stage=f"向量化 0/{total_chunks}",
        progress=25,
        chunks=total_chunks,
        chars=total_chars,
    )

    embedder = get_embedder()
    cfg = load_config()
    step = max(1, cfg.batch_size)

    # 先把所有向量算完再写库：写库是毫秒级，embedding 是秒级，
    # 只有全成功才落库，避免「一半文档进了库、一半失败」这种半成品状态。
    vectors_by_doc: list[list[list[float]]] = []
    done = 0
    for doc, chunks in prepared:
        texts = [embed_text(doc.title, c.heading, c.content) for c in chunks]
        vectors: list[list[float]] = []
        for start in range(0, len(texts), step):
            vectors.extend(embedder.embed_texts(texts[start : start + step]))
            done = min(total_chunks, done + len(texts[start : start + step]))
            # 25 → 85 之间按块数线性推进，前端进度条不会长时间僵住
            pct = 25 + int(60 * done / total_chunks)
            _update(job_id, stage=f"向量化 {done}/{total_chunks}", progress=min(pct, 85))
        vectors_by_doc.append(vectors)

    _update(job_id, status="indexing", stage="写入索引", progress=90)

    store = KBStore(load_config(), create=True)
    store.init_schema()
    added_chunks = 0
    doc_ids: list[int] = []
    for (doc, chunks), vectors in zip(prepared, vectors_by_doc):
        result = store.upsert_document(
            doc_key=doc.doc_key,
            title=doc.title,
            source=doc.source,
            doc_type=doc.doc_type,
            chunks=chunks,
            vectors=vectors,
            meta=doc.meta,
        )
        added_chunks += result.chunks
        if result.doc_id:
            doc_ids.append(result.doc_id)
    store.close()

    _update(
        job_id,
        status="done",
        stage="已入库，可被检索" if added_chunks else "内容未变，已跳过",
        progress=100,
        chunks=added_chunks or total_chunks,
        doc_ids=doc_ids,
        finished_at=_now(),
    )
