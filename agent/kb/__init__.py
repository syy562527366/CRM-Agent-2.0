"""本地知识库（sqlite-vec 向量检索）。

分层：
    config     读环境变量（embedding 服务、库路径）
    embedding  硅基流动 /v1/embeddings 客户端（批量 + 重试 + 查询缓存）
    chunker    中文友好的 Markdown 切块
    store      kb.sqlite3 的建表 / 写入 / 检索
    loader     各类语料 → 文档 + 切块
    cli        离线命令：init / ingest / search / stats / reset

在线侧只做读：`tools_kb.kb_search` 被 Agent 调用，不写库。
"""

from kb.config import KBConfig, load_config

__all__ = ["KBConfig", "load_config"]
