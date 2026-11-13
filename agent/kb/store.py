"""kb.sqlite3：文档 / 切块 / 向量三层存储。

表结构（与 sqlite-vec 的列语义严格对应）：

    kb_docs      普通表，文档元信息。doc_key 幂等，重复导入只更新不重复插入。
    kb_chunks    普通表，切块正文。放在普通表而不是 vec0 的 auxiliary 列，
                 因为 vec0 的 `+col` 只回传、不能过滤也不能 JOIN，正文放里面
                 等于把自己锁死；放普通表还能随时加全文索引。
    vec_chunks   vec0 虚拟表，只存向量 + 两个 metadata 列（doc_id / doc_type）。
                 metadata 列是 vec0 里**唯一支持 KNN 内 WHERE 过滤**的列类型，
                 写成 `+doc_type` 会直接报 "illegal WHERE constraint"。

检索流程：vec0 取 top-k chunk_id → JOIN kb_chunks 取正文 → JOIN kb_docs 取标题。
"""

from __future__ import annotations

import json
import sqlite3
import struct
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from kb.chunker import Chunk
from kb.config import KBConfig, load_config
from kb.embedding import text_fingerprint

SCHEMA_VERSION = 1


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def pack_vector(vec: Sequence[float]) -> bytes:
    """float32 小端打包。vec0 只认二进制向量或 JSON 数组，二进制更省。"""
    return struct.pack(f"{len(vec)}f", *vec)


def _bigrams(text: str) -> set[str]:
    """字符 bigram 集合，用于关键词重排。

    为什么用 bigram 而不是分词：中文分词要引依赖（jieba 带词典、冷启动慢），
    而这里只需要「字面命中度」这一粗信号。bigram 对中文足够，
    英文词会被拆成 cb/ba/am 这种碎片，但仍能命中，不影响排序方向。
    """
    key = "".join(ch.lower() for ch in (text or "") if ch.isalnum())
    if len(key) < 2:
        return {key} if key else set()
    return {key[i : i + 2] for i in range(len(key) - 1)}


@dataclass
class Hit:
    chunk_id: int
    doc_id: int
    distance: float
    score: float
    title: str
    source: str
    doc_type: str
    heading: str
    content: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "doc_id": self.doc_id,
            "score": round(self.score, 4),
            "title": self.title,
            "source": self.source,
            "doc_type": self.doc_type,
            "heading": self.heading,
            "content": self.content,
        }


@dataclass
class UpsertResult:
    doc_id: int
    chunks: int
    skipped: bool = False
    reason: str = ""


def locate_extension() -> Path:
    """定位 vec0 动态库。

    优先用 pip 包 `sqlite_vec` 自带的产物（版本与运行环境一致），
    找不到再回退到项目内 `sqlite-vec/dist/vec0.*`（离线部署场景）。
    """
    try:
        import sqlite_vec

        pkg = Path(sqlite_vec.__file__).parent
        for name in ("vec0.dll", "vec0.so", "vec0.dylib"):
            cand = pkg / name
            if cand.exists():
                return cand
    except ImportError:
        pass

    repo = Path(__file__).resolve().parents[3] / "sqlite-vec" / "dist"
    for name in ("vec0.dll", "vec0.so", "vec0.dylib"):
        cand = repo / name
        if cand.exists():
            return cand

    raise RuntimeError(
        "找不到 vec0 扩展。请执行：pip install sqlite-vec，"
        "或将 vec0.dll 放到 sqlite-vec/dist/ 下"
    )


class KBStore:
    """知识库读写入口。一个实例持有一个连接，**不要跨线程共用**。"""

    def __init__(self, config: KBConfig | None = None, create: bool = False) -> None:
        self.cfg = config or load_config()
        self.db_path = self.cfg.db_path
        self._ext = locate_extension()

        if not create and not self.db_path.exists():
            raise RuntimeError(
                f"知识库不存在：{self.db_path}。先执行 python -m kb.cli init"
            )

        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.db_path), timeout=10)
        self.conn.row_factory = sqlite3.Row
        self._load_extension()
        # WAL：读写并发更友好，导入时不会把在线检索锁死
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=8000")
        self.conn.execute("PRAGMA foreign_keys=ON")

    # ---------------------------------------------------------------- 生命周期

    def _load_extension(self) -> None:
        self.conn.enable_load_extension(True)
        try:
            self.conn.load_extension(str(self._ext))
        finally:
            self.conn.enable_load_extension(False)

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "KBStore":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---------------------------------------------------------------- 建表

    def init_schema(self, reset: bool = False) -> None:
        if reset:
            for stmt in (
                "DROP TABLE IF EXISTS vec_chunks",
                "DROP TABLE IF EXISTS kb_chunks",
                "DROP TABLE IF EXISTS kb_docs",
                "DROP TABLE IF EXISTS kb_meta",
            ):
                self.conn.execute(stmt)

        self.conn.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS kb_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS kb_docs (
                doc_id       INTEGER PRIMARY KEY,
                doc_key      TEXT NOT NULL UNIQUE,
                title        TEXT NOT NULL,
                source       TEXT NOT NULL,
                doc_type     TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                chunk_count  INTEGER NOT NULL DEFAULT 0,
                char_count   INTEGER NOT NULL DEFAULT 0,
                meta         TEXT NOT NULL DEFAULT '{{}}',
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_kb_docs_type ON kb_docs(doc_type);

            CREATE TABLE IF NOT EXISTS kb_chunks (
                chunk_id INTEGER PRIMARY KEY,
                doc_id   INTEGER NOT NULL REFERENCES kb_docs(doc_id) ON DELETE CASCADE,
                ord      INTEGER NOT NULL,
                heading  TEXT NOT NULL DEFAULT '',
                content  TEXT NOT NULL,
                char_len INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id);

            CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
                chunk_id INTEGER PRIMARY KEY,
                embedding float[{self.cfg.dim}] distance_metric=cosine,
                doc_id   INTEGER,
                doc_type TEXT
            );
            """
        )
        self._set_meta("schema_version", str(SCHEMA_VERSION))
        self._set_meta("embedding_model", self.cfg.model)
        self._set_meta("embedding_dim", str(self.cfg.dim))
        self.conn.commit()

    def _set_meta(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO kb_meta(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    def get_meta(self) -> dict[str, str]:
        return {r["key"]: r["value"] for r in self.conn.execute("SELECT key, value FROM kb_meta")}

    # ---------------------------------------------------------------- 写入

    def upsert_document(
        self,
        *,
        doc_key: str,
        title: str,
        source: str,
        doc_type: str,
        chunks: list[Chunk],
        vectors: list[list[float]],
        meta: dict[str, Any] | None = None,
        force: bool = False,
    ) -> UpsertResult:
        """幂等写入一份文档。

        doc_key 相同且内容指纹未变时跳过（除非 force）。
        内容变了就整篇替换 —— 按块做 diff 收益不大，反而容易出现
        「正文更新了、向量还是旧的」这种最难排查的脏数据。
        """
        if len(chunks) != len(vectors):
            raise ValueError(f"切块数 {len(chunks)} 与向量数 {len(vectors)} 不一致")
        if not chunks:
            return UpsertResult(doc_id=0, chunks=0, skipped=True, reason="没有可用切块")

        raw = "\n\n".join(c.content for c in chunks)
        fingerprint = text_fingerprint(f"{title}\n{raw}")
        for vec in vectors:
            if len(vec) != self.cfg.dim:
                raise ValueError(f"向量维度 {len(vec)} 与配置 {self.cfg.dim} 不一致")

        row = self.conn.execute(
            "SELECT doc_id, content_hash FROM kb_docs WHERE doc_key = ?", (doc_key,)
        ).fetchone()

        if row and row["content_hash"] == fingerprint and not force:
            return UpsertResult(doc_id=row["doc_id"], chunks=0, skipped=True, reason="内容未变")

        now = _now()
        meta_json = json.dumps(meta or {}, ensure_ascii=False)

        try:
            if row:
                doc_id = row["doc_id"]
                self._delete_chunks_of(doc_id)
                self.conn.execute(
                    "UPDATE kb_docs SET title=?, source=?, doc_type=?, content_hash=?, "
                    "chunk_count=?, char_count=?, meta=?, updated_at=? WHERE doc_id=?",
                    (
                        title,
                        source,
                        doc_type,
                        fingerprint,
                        len(chunks),
                        len(raw),
                        meta_json,
                        now,
                        doc_id,
                    ),
                )
            else:
                cur = self.conn.execute(
                    "INSERT INTO kb_docs(doc_key, title, source, doc_type, content_hash, "
                    "chunk_count, char_count, meta, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (doc_key, title, source, doc_type, fingerprint, len(chunks), len(raw), meta_json, now, now),
                )
                doc_id = int(cur.lastrowid or 0)

            self._insert_chunks(doc_id, doc_type, chunks, vectors)
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

        return UpsertResult(doc_id=doc_id, chunks=len(chunks))

    def _insert_chunks(
        self,
        doc_id: int,
        doc_type: str,
        chunks: list[Chunk],
        vectors: list[list[float]],
    ) -> None:
        rows = [
            (doc_id, c.ord, c.heading, c.content, c.char_len) for c in chunks
        ]
        cur = self.conn.executemany(
            "INSERT INTO kb_chunks(doc_id, ord, heading, content, char_len) VALUES (?,?,?,?,?)",
            rows,
        )
        # executemany 不返回各行的 lastrowid，重新按 (doc_id, ord) 取回更稳
        ids = [
            r["chunk_id"]
            for r in self.conn.execute(
                "SELECT chunk_id FROM kb_chunks WHERE doc_id = ? ORDER BY ord", (doc_id,)
            )
        ]
        if len(ids) != len(vectors):
            raise RuntimeError(f"切块入库数量异常：{len(ids)} vs {len(vectors)}")

        self.conn.executemany(
            "INSERT INTO vec_chunks(chunk_id, embedding, doc_id, doc_type) VALUES (?,?,?,?)",
            [
                (cid, pack_vector(vec), doc_id, doc_type)
                for cid, vec in zip(ids, vectors)
            ],
        )

    def _delete_chunks_of(self, doc_id: int) -> None:
        ids = [r["chunk_id"] for r in self.conn.execute(
            "SELECT chunk_id FROM kb_chunks WHERE doc_id = ?", (doc_id,)
        )]
        # vec0 对批量 IN 删除支持不稳，逐条按主键删最可靠
        for cid in ids:
            self.conn.execute("DELETE FROM vec_chunks WHERE chunk_id = ?", (cid,))
        self.conn.execute("DELETE FROM kb_chunks WHERE doc_id = ?", (doc_id,))

    def delete_document(self, doc_key: str) -> bool:
        row = self.conn.execute(
            "SELECT doc_id FROM kb_docs WHERE doc_key = ?", (doc_key,)
        ).fetchone()
        if not row:
            return False
        return self.delete_document_by_id(int(row["doc_id"]))

    def delete_document_by_id(self, doc_id: int) -> bool:
        """按 doc_id 删除（知识库管理页面用）。

        必须连 vec_chunks 一起删：vec0 是普通虚拟表，没有外键级联，
        只删 kb_docs 会留下孤儿向量，检索时 JOIN 不上正文却又占着 KNN 名额，
        表现就是「明明删了，top_k 却少一条」。
        """
        row = self.conn.execute(
            "SELECT doc_id FROM kb_docs WHERE doc_id = ?", (doc_id,)
        ).fetchone()
        if not row:
            return False
        try:
            self._delete_chunks_of(doc_id)
            self.conn.execute("DELETE FROM kb_docs WHERE doc_id = ?", (doc_id,))
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise
        return True

    # ---------------------------------------------------------------- 检索

    def search(
        self,
        vector: Sequence[float],
        top_k: int = 5,
        doc_type: str | None = None,
        min_score: float | None = None,
        query_text: str | None = None,
        keyword_weight: float = 0.15,
        max_per_doc: int = 2,
    ) -> list[Hit]:
        """混合检索：向量召回 → 关键词加分 → 同文档限流。

        为什么要关键词加分：纯向量对「改写」容忍度高，但对「字面命中」不敏感。
        实测「周报应该按什么结构写」的首位是「何时使用」而非「执行步骤」，
        语义都接近，向量分不开。

        分数构成是 **cosine + keyword_weight × 字面覆盖率**，是加法不是加权平均：
        加权平均会把 0.88 的正确命中也压到 0.70，让 min_score 阈值失去可比性；
        加法下分数主体仍是 cosine，加分项最多 keyword_weight，语义保持稳定。

        max_per_doc 限制同一文档的占位：一篇长文档的长小节会被切成多块且共享
        heading，不限制的话 top5 可能被 4 个同源碎片占满，挤掉别的文档。
        默认 2 是「够深但不贪」：一个问题问到底两段基本齐全，而对比类问题
        （「绿证和碳交易有什么区别」）才留得下另一个产品的名额——设成 3 时
        实测 top3 全是绿证，碳交易一条都进不来。

        Args:
            vector: 已归一化的查询向量（1024 维）
            top_k: 最终返回条数
            doc_type: 只在某一类文档里检索（faq / product / skill / doc）
            min_score: 最低分阈值，低于此值的丢弃
            query_text: 原始查询文本；给了才启用关键词加分
            keyword_weight: 关键词加分上限，0 表示纯向量
            max_per_doc: 同一文档最多返回几条；0 表示不限
        """
        if len(vector) != self.cfg.dim:
            raise ValueError(f"查询向量维度 {len(vector)} 与配置 {self.cfg.dim} 不一致")

        # 先多捞一些，重排和限流后才有余量
        fetch = max(top_k * 4, 20)

        where = ["v.embedding MATCH ?", "v.k = ?"]
        params: list[Any] = [pack_vector(vector), fetch]
        if doc_type:
            where.append("v.doc_type = ?")
            params.append(doc_type)

        sql = f"""
            SELECT v.chunk_id     AS chunk_id,
                   v.doc_id       AS doc_id,
                   v.distance     AS distance,
                   d.title        AS title,
                   d.source       AS source,
                   d.doc_type     AS doc_type,
                   c.heading      AS heading,
                   c.content      AS content
            FROM vec_chunks v
            JOIN kb_chunks c ON c.chunk_id = v.chunk_id
            JOIN kb_docs   d ON d.doc_id   = c.doc_id
            WHERE {' AND '.join(where)}
            ORDER BY v.distance
        """

        q_terms = _bigrams(query_text) if (query_text and keyword_weight > 0) else set()

        scored: list[tuple[float, Hit]] = []
        for row in self.conn.execute(sql, params):
            dist = float(row["distance"])
            cos = 1.0 - dist
            hit = Hit(
                chunk_id=int(row["chunk_id"]),
                doc_id=int(row["doc_id"]),
                distance=dist,
                score=cos,
                title=row["title"],
                source=row["source"],
                doc_type=row["doc_type"],
                heading=row["heading"],
                content=row["content"],
            )
            if q_terms:
                text = f"{hit.title} {hit.heading} {hit.content}"
                overlap = len(q_terms & _bigrams(text)) / len(q_terms)
                final = cos + overlap * keyword_weight
            else:
                final = cos
            scored.append((final, hit))

        scored.sort(key=lambda x: x[0], reverse=True)

        out: list[Hit] = []
        per_doc: dict[int, int] = {}
        for final, hit in scored:
            if min_score is not None and final < min_score:
                continue
            if max_per_doc and per_doc.get(hit.doc_id, 0) >= max_per_doc:
                continue
            per_doc[hit.doc_id] = per_doc.get(hit.doc_id, 0) + 1
            hit.score = final
            out.append(hit)
            if len(out) >= top_k:
                break
        return out

    # ---------------------------------------------------------------- 统计

    def stats(self) -> dict[str, Any]:
        docs = self.conn.execute("SELECT COUNT(*) AS n FROM kb_docs").fetchone()["n"]
        chunks = self.conn.execute("SELECT COUNT(*) AS n FROM kb_chunks").fetchone()["n"]
        chars = self.conn.execute("SELECT COALESCE(SUM(char_len),0) AS n FROM kb_chunks").fetchone()["n"]
        by_type = {
            r["doc_type"]: {"docs": r["docs"], "chunks": r["chunks"]}
            for r in self.conn.execute(
                "SELECT doc_type, COUNT(*) AS docs, SUM(chunk_count) AS chunks "
                "FROM kb_docs GROUP BY doc_type ORDER BY doc_type"
            )
        }
        try:
            vec_count = self.conn.execute("SELECT COUNT(*) AS n FROM vec_chunks").fetchone()["n"]
        except sqlite3.Error:
            vec_count = -1
        return {
            "db_path": str(self.db_path),
            "dim": self.cfg.dim,
            "model": self.cfg.model,
            "docs": docs,
            "chunks": chunks,
            "vectors": vec_count,
            "chars": chars,
            "by_type": by_type,
            "meta": self.get_meta(),
        }

    def get_document(self, doc_id: int) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM kb_docs WHERE doc_id = ?", (doc_id,)).fetchone()
        if not row:
            return None
        return {
            "doc_id": row["doc_id"],
            "doc_key": row["doc_key"],
            "title": row["title"],
            "source": row["source"],
            "doc_type": row["doc_type"],
            "chunks": row["chunk_count"],
            "chars": row["char_count"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def list_chunks(self, doc_id: int, limit: int = 500) -> list[dict[str, Any]]:
        """按 ord 返回一篇文档的切块正文，供管理页查看切分效果。

        正文取 kb_chunks.content（入库时的原始切块），不是 vec_chunks 里的向量
        ——向量没法反解成人话，能看的就是这段文本。
        """
        return [
            {
                "ord": r["ord"],
                "heading": r["heading"],
                "chars": r["char_len"],
                "content": r["content"],
            }
            for r in self.conn.execute(
                "SELECT ord, heading, content, char_len FROM kb_chunks "
                "WHERE doc_id = ? ORDER BY ord LIMIT ?",
                (doc_id, limit),
            )
        ]

    def list_documents(self, limit: int = 500) -> list[dict[str, Any]]:
        return [
            {
                "doc_id": r["doc_id"],
                "doc_key": r["doc_key"],
                "title": r["title"],
                "source": r["source"],
                "doc_type": r["doc_type"],
                "chunks": r["chunk_count"],
                "chars": r["char_count"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
            }
            for r in self.conn.execute(
                "SELECT * FROM kb_docs ORDER BY updated_at DESC, doc_id DESC LIMIT ?", (limit,)
            )
        ]
