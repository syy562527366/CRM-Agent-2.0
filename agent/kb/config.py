"""知识库配置：全部来自 agent/.env，不写死在代码里。

为什么维度必须显式配置：vec0 的建表语句里 `float[N]` 是硬编码的，
维度写错不会报错，只会在插入时抛 dimension mismatch。所以启动时校验一次，
比等到建库第 300 条才失败要好。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

AGENT_DIR = Path(__file__).resolve().parent.parent

# Qwen3-Embedding-0.6B 的原生维度。低于原生维度需要用 MRL 截断，
# 截断会让相似度分布变化，非必要不做。
DEFAULT_DIM = 1024


@dataclass(frozen=True)
class KBConfig:
    """知识库运行参数。"""

    db_path: Path
    api_key: str
    base_url: str
    model: str
    dim: int
    # 单次请求最多送几条。实测 40 条可通，留出余量取 32，
    # 避免长文本时撞到服务端的 token 上限。
    batch_size: int = 32
    timeout: int = 60
    # 单条文本送进 embedding 前的截断长度（字符）。Qwen3 支持 32k，
    # 但我们的切块上限远小于此，这里是兜底。
    max_input_chars: int = 2000

    @property
    def endpoint(self) -> str:
        return f"{self.base_url.rstrip('/')}/embeddings"


def load_config() -> KBConfig:
    """从环境变量读配置。缺 API key 时抛错，不静默降级。"""
    api_key = (os.getenv("SILICONFLOW_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError(
            "缺少 SILICONFLOW_API_KEY，请在 agent/.env 中配置硅基流动 API Key"
        )

    raw_dim = (os.getenv("EMBEDDING_DIM") or str(DEFAULT_DIM)).strip()
    try:
        dim = int(raw_dim)
    except ValueError as exc:
        raise RuntimeError(f"EMBEDDING_DIM 必须是整数，当前为 {raw_dim!r}") from exc
    if dim <= 0 or dim > 4096:
        raise RuntimeError(f"EMBEDDING_DIM 超出合理范围：{dim}")

    raw_db = (os.getenv("KB_DB_PATH") or "").strip()
    db_path = Path(raw_db) if raw_db else AGENT_DIR / "data" / "kb.sqlite3"
    if not db_path.is_absolute():
        db_path = (AGENT_DIR / db_path).resolve()

    return KBConfig(
        db_path=db_path,
        api_key=api_key,
        base_url=(os.getenv("SILICONFLOW_BASE_URL") or "https://api.siliconflow.cn/v1").strip(),
        model=(os.getenv("EMBEDDING_MODEL") or "Qwen/Qwen3-Embedding-0.6B").strip(),
        dim=dim,
        batch_size=int(os.getenv("EMBEDDING_BATCH_SIZE") or 32),
        timeout=int(os.getenv("EMBEDDING_TIMEOUT") or 60),
    )
