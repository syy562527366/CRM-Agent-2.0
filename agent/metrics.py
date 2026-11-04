"""对话调用指标：每次请求的耗时、token、工具调用。

存在 `agent/data/agent.db` 的 `chat_metrics` 表（与会话、checkpoint 同一个库，
方便一起备份）。为什么要落库而不是只放内存：控制面板要能看「今日」「近 7 天」，
进程重启后这些数字还得在。

口径说明（面板上也是这么写的）：

- **调用次数**：一次 `/chat/stream` 或 `/chat/resume` 算一次，不是消息条数；
- **平均响应耗时**：从请求进来到 SSE 结束（含工具调用）的墙钟时间；
- **Token**：模型返回的 `usage_metadata`，一轮里多次调模型会累加；
- **工具调用次数**：本轮里实际发起（并返回结果）的工具调用个数。
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import date, datetime, timedelta
from typing import Any

_LOCK = threading.Lock()

DB_PATH = os.getenv(
    "AGENT_DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "agent.db"),
)

_conn: sqlite3.Connection | None = None


def _db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=20)
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA busy_timeout=20000")
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_metrics (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                ts               TEXT    NOT NULL,
                day              TEXT    NOT NULL,
                uid              TEXT    NOT NULL DEFAULT '',
                thread_id        TEXT    NOT NULL DEFAULT '',
                entry            TEXT    NOT NULL DEFAULT 'chat',
                duration_ms      INTEGER NOT NULL DEFAULT 0,
                prompt_tokens    INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens     INTEGER NOT NULL DEFAULT 0,
                tool_calls       INTEGER NOT NULL DEFAULT 0,
                tools            TEXT    NOT NULL DEFAULT '',
                model            TEXT    NOT NULL DEFAULT '',
                ok               INTEGER NOT NULL DEFAULT 1,
                error            TEXT    NOT NULL DEFAULT ''
            )
            """
        )
        _conn.execute("CREATE INDEX IF NOT EXISTS idx_metrics_day ON chat_metrics(day)")
        _conn.commit()
    return _conn


def today_key() -> str:
    return date.today().isoformat()


def record(
    *,
    duration_ms: int,
    uid: str = "",
    thread_id: str = "",
    entry: str = "chat",
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    total_tokens: int = 0,
    tools: list[str] | None = None,
    model: str = "",
    ok: bool = True,
    error: str = "",
) -> None:
    """记一次调用。写失败不能影响对话本身，所以这里吞掉异常。"""
    tools = tools or []
    row = (
        datetime.now().astimezone().isoformat(timespec="seconds"),
        today_key(),
        uid or "",
        thread_id or "",
        entry,
        max(0, int(duration_ms)),
        max(0, int(prompt_tokens)),
        max(0, int(completion_tokens)),
        max(0, int(total_tokens)),
        len(tools),
        json.dumps(tools, ensure_ascii=False),
        model or "",
        1 if ok else 0,
        (error or "")[:500],
    )
    try:
        with _LOCK:
            conn = _db()
            conn.execute(
                "INSERT INTO chat_metrics (ts, day, uid, thread_id, entry, duration_ms,"
                " prompt_tokens, completion_tokens, total_tokens, tool_calls, tools, model, ok, error)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                row,
            )
            conn.commit()
    except Exception:  # noqa: BLE001 - 指标不该拖垮业务
        pass


def _agg(day: str) -> dict[str, Any]:
    conn = _db()
    row = conn.execute(
        "SELECT COUNT(*), COALESCE(AVG(duration_ms),0), COALESCE(SUM(tool_calls),0),"
        " COALESCE(SUM(total_tokens),0), COALESCE(SUM(prompt_tokens),0),"
        " COALESCE(SUM(completion_tokens),0), COALESCE(SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END),0),"
        " COUNT(DISTINCT thread_id)"
        " FROM chat_metrics WHERE day = ?",
        (day,),
    ).fetchone()
    return {
        "calls": int(row[0] or 0),
        "avg_ms": int(round(row[1] or 0)),
        "tool_calls": int(row[2] or 0),
        "total_tokens": int(row[3] or 0),
        "prompt_tokens": int(row[4] or 0),
        "completion_tokens": int(row[5] or 0),
        "errors": int(row[6] or 0),
        "threads": int(row[7] or 0),
    }


def _p95(day: str) -> int:
    rows = _db().execute(
        "SELECT duration_ms FROM chat_metrics WHERE day = ? ORDER BY duration_ms", (day,)
    ).fetchall()
    if not rows:
        return 0
    index = max(0, min(len(rows) - 1, int(round(len(rows) * 0.95)) - 1))
    return int(rows[index][0] or 0)


def _trend(days: int = 7) -> list[dict[str, Any]]:
    start = date.today() - timedelta(days=days - 1)
    rows = _db().execute(
        "SELECT day, COUNT(*), COALESCE(SUM(total_tokens),0), COALESCE(AVG(duration_ms),0)"
        " FROM chat_metrics WHERE day >= ? GROUP BY day",
        (start.isoformat(),),
    ).fetchall()
    found = {row[0]: row for row in rows}
    out: list[dict[str, Any]] = []
    for offset in range(days):
        day = (start + timedelta(days=offset)).isoformat()
        row = found.get(day)
        out.append(
            {
                "day": day,
                "calls": int(row[1]) if row else 0,
                "tokens": int(row[2]) if row else 0,
                "avg_ms": int(round(row[3] or 0)) if row else 0,
            }
        )
    return out


def _top_tools(days: int = 7, limit: int = 6) -> list[dict[str, Any]]:
    start = (date.today() - timedelta(days=days - 1)).isoformat()
    rows = _db().execute(
        "SELECT tools FROM chat_metrics WHERE day >= ? AND tools != '' AND tools != '[]'", (start,)
    ).fetchall()
    counter: dict[str, int] = {}
    for (blob,) in rows:
        try:
            names = json.loads(blob)
        except (json.JSONDecodeError, TypeError):
            continue
        for name in names if isinstance(names, list) else []:
            counter[str(name)] = counter.get(str(name), 0) + 1
    ordered = sorted(counter.items(), key=lambda item: item[1], reverse=True)[:limit]
    return [{"name": name, "count": count} for name, count in ordered]


def _last_call() -> str:
    row = _db().execute("SELECT ts FROM chat_metrics ORDER BY id DESC LIMIT 1").fetchone()
    return str(row[0]) if row else ""


def overview(days: int = 7) -> dict[str, Any]:
    today = today_key()
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    return {
        "today": {**_agg(today), "p95_ms": _p95(today), "day": today},
        "yesterday": _agg(yesterday),
        "trend": _trend(days),
        "top_tools": _top_tools(),
        "last_call_at": _last_call(),
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
