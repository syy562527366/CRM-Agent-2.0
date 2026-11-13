"""硅基流动 embedding 客户端。

接口：POST {base_url}/embeddings（OpenAI 兼容）
    入参 {"model": "...", "input": [...], "encoding_format": "float"}
    出参 {"data": [{"index": 0, "embedding": [...]}], "usage": {...}}

实测结论（2026-11-13，Qwen/Qwen3-Embedding-0.6B）：
- 维度 1024，**输出已归一化**（模长 = 1.0），因此建表用 cosine，
  检索时不必再手工归一化查询向量；
- 单次 40 条可通，本模块按 32 条分批，留 token 余量；
- data 数组按 index 排序，不一定与入参顺序一致，**必须按 index 回填**。

为什么要带缓存：交互式检索里同一个问题常被重复提问（模型可能在一轮内
多次调 kb_search），每次都要付一次 API 延迟与费用，加一层内存缓存很划算。
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import threading
import time
from typing import Sequence

import httpx

from kb.config import KBConfig, load_config

# 可重试的状态码：限流与服务端故障
_RETRY_STATUS = {408, 409, 429, 500, 502, 503, 504}
_MAX_RETRY = 4


class EmbeddingError(RuntimeError):
    """embedding 调用失败，附带可读原因。"""


class Embedder:
    """同步 embedding 客户端，线程安全。"""

    def __init__(self, config: KBConfig) -> None:
        self._cfg = config
        self._client = httpx.Client(
            timeout=config.timeout,
            headers={
                "Authorization": f"Bearer {config.api_key}",
                "Content-Type": "application/json",
            },
        )
        # 查询缓存：text -> vector。只缓存单条查询，批量导入不缓存（一次性）。
        self._cache: dict[str, list[float]] = {}
        self._cache_lock = threading.Lock()
        self._cache_cap = 512
        self.calls = 0  # 实际发出的请求数，便于观测
        self.tokens = 0

    # ---------------------------------------------------------------- 公开方法

    @property
    def dim(self) -> int:
        return self._cfg.dim

    def embed_texts(self, texts: Sequence[str]) -> list[list[float]]:
        """批量向量化。返回顺序与入参严格一致。"""
        cleaned = [self._clean(t) for t in texts]
        if not cleaned:
            return []

        out: list[list[float]] = []
        step = max(1, self._cfg.batch_size)
        for start in range(0, len(cleaned), step):
            out.extend(self._request(cleaned[start : start + step]))
        return out

    def embed_query(self, text: str) -> list[float]:
        """单条查询，带缓存。"""
        key = self._clean(text)
        if not key:
            raise EmbeddingError("查询文本为空")
        with self._cache_lock:
            hit = self._cache.get(key)
        if hit is not None:
            return hit

        vec = self._request([key])[0]
        with self._cache_lock:
            if len(self._cache) >= self._cache_cap:
                # 简单淘汰：清一半，避免引入额外依赖
                for old in list(self._cache)[: self._cache_cap // 2]:
                    self._cache.pop(old, None)
            self._cache[key] = vec
        return vec

    def close(self) -> None:
        self._client.close()

    # ---------------------------------------------------------------- 内部实现

    def _clean(self, text: str) -> str:
        """压缩空白 + 截断。空行在 embedding 里没有语义价值，反而费 token。"""
        flat = " ".join((text or "").split())
        return flat[: self._cfg.max_input_chars]

    def _request(self, batch: list[str]) -> list[list[float]]:
        payload = {
            "model": self._cfg.model,
            "input": batch,
            "encoding_format": "float",
        }
        last_err = ""
        for attempt in range(_MAX_RETRY):
            try:
                resp = self._client.post(self._cfg.endpoint, json=payload)
            except httpx.HTTPError as exc:
                last_err = f"网络异常：{exc}"
                self._sleep(attempt)
                continue

            if resp.status_code == 200:
                return self._parse(resp, len(batch))

            last_err = f"HTTP {resp.status_code}：{resp.text[:200]}"
            if resp.status_code in _RETRY_STATUS:
                self._sleep(attempt)
                continue
            # 401/403/400 这类重试无意义，直接抛
            raise EmbeddingError(last_err)

        raise EmbeddingError(f"embedding 调用重试 {_MAX_RETRY} 次仍失败：{last_err}")

    def _parse(self, resp: httpx.Response, expected: int) -> list[list[float]]:
        try:
            body = resp.json()
        except json.JSONDecodeError as exc:
            raise EmbeddingError(f"响应不是合法 JSON：{resp.text[:200]}") from exc

        rows = body.get("data")
        if not isinstance(rows, list) or len(rows) != expected:
            raise EmbeddingError(
                f"返回条数不符：期望 {expected}，实际 "
                f"{len(rows) if isinstance(rows, list) else '无 data 字段'}"
            )

        # 按 index 回填，防止服务端返回乱序
        ordered: list[list[float] | None] = [None] * expected
        for pos, row in enumerate(rows):
            idx = row.get("index", pos)
            vec = row.get("embedding")
            if not isinstance(vec, list):
                raise EmbeddingError("data[].embedding 缺失或不是数组")
            if len(vec) != self._cfg.dim:
                raise EmbeddingError(
                    f"维度不符：配置 {self._cfg.dim}，实际 {len(vec)}。"
                    "请确认 EMBEDDING_MODEL 与 EMBEDDING_DIM 是否匹配"
                )
            if idx < 0 or idx >= expected:
                raise EmbeddingError(f"data[].index 越界：{idx}")
            ordered[idx] = [float(x) for x in vec]

        if any(v is None for v in ordered):
            raise EmbeddingError("返回条目不完整，存在空缺 index")

        usage = body.get("usage") or {}
        self.calls += 1
        self.tokens += int(usage.get("total_tokens") or 0)
        return ordered  # type: ignore[return-value]

    def _sleep(self, attempt: int) -> None:
        base = min(2 ** attempt * 0.5, 8)
        time.sleep(base + random.uniform(0, 0.3))


# --------------------------------------------------------------------------- #
# 进程级单例
# --------------------------------------------------------------------------- #

_holder: dict[str, Embedder] = {}
_holder_lock = threading.Lock()


def get_embedder() -> Embedder:
    """懒加载全局 embedder。配置有问题时在这里暴露，而不是在第一次检索时。"""
    if "inst" not in _holder:
        with _holder_lock:
            if "inst" not in _holder:
                _holder["inst"] = Embedder(load_config())
    return _holder["inst"]


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """参考实现：两端都已归一化时直接点积即可，这里保留完整公式做校验用。"""
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def text_fingerprint(text: str) -> str:
    """文本指纹，用于判断文档是否变更（增量导入）。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
