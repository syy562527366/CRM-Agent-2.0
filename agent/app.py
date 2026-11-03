"""基础 DeepAgent 服务（deepagents + DeepSeek）。

启动：
    agent/.venv/Scripts/python.exe -m uvicorn app:app --app-dir agent --host 127.0.0.1 --port 3200

接口：
    GET    /health             健康检查（含模型信息）
    GET    /tools              已注册工具列表
    GET    /whoami             回显调用者身份（排查 x-crm-* 头是否透传）
    GET    /sessions           会话列表（按最近活跃时间倒序）
    POST   /sessions           新建会话
    PATCH  /sessions/{id}      重命名会话
    DELETE /sessions/{id}      删除会话（连同对话记录）
    GET    /threads/{id}       某会话的完整消息历史（前端渲染用）
    POST   /chat               同步对话（多轮靠 thread_id 维持上下文）
    POST   /chat/stream        SSE 流式对话，逐 token 推送
"""

from __future__ import annotations

import base64
import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Iterator

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_deepseek import ChatDeepSeek
from langgraph.checkpoint.sqlite import SqliteSaver
from pydantic import BaseModel, Field

from tools import TOOLS

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

MODEL_ID = os.getenv("DEEPSEEK_MODEL", "deepseek-flash")
API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
API_BASE = os.getenv("DEEPSEEK_API_BASE", "https://api.deepseek.com/v1")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.getenv("AGENT_DB_PATH", os.path.join(DATA_DIR, "agent.db"))

SYSTEM_PROMPT = """你是一个严谨、简洁的中文智能助手，运行在本地部署的 DeepAgent 服务中，服务于一套 CRM 系统。

工作要求：
1. 先理解用户目标，需要多步任务时用 todo 工具拆解，再逐项推进。
2. 涉及算术必须调用 calculator 工具，不要心算；涉及“现在几点”必须调用 get_current_time。
3. 涉及具体客户 / 线索 / 订单数据时，必须调用 crm_read_leads 取真实数据，严禁编造客户信息。
4. 工具返回结果后，用自然中文总结结论，不要粘贴原始 JSON。
5. 不确定的信息要明确说明不确定，不要编造。
6. 回答控制在 200 字以内，除非用户要求展开。
7. 当用户要求「分析某条线索 / 客户」时，除了给一句简短结论，还要在回答末尾输出一个线索分析卡片，格式为：

```lead-analysis-card
{"customer":"客户姓名","leadId":"LD-2026-0001","intent":"high","intentProduct":"意向产品","budget":"预算区间","commCount":5,"lastCommDate":"2026-06-05","competitors":[{"name":"竞品名","attitude":"price_sensitive","quote":"客户原话"}],"actions":[{"title":"动作标题","detail":"具体做法"}]}
```

卡片字段要求：intent 只能是 high / medium / low；attitude 只能是 positive / neutral / negative / price_sensitive；没有竞品时给空数组；JSON 必须单行合法，不要在围栏里写注释或换行说明。
"""

app = FastAPI(title="DeepAgent Service", version="0.2.0")


# --------------------------------------------------------------------------- #
# 持久化：SQLite（checkpointer 存对话状态 + sessions 表存会话索引）
# --------------------------------------------------------------------------- #
_ckpt_conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=20)
_ckpt_conn.execute("PRAGMA journal_mode=WAL")
_ckpt_conn.execute("PRAGMA busy_timeout=20000")
checkpointer = SqliteSaver(_ckpt_conn)

_session_lock = threading.Lock()
_session_conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=20)
_session_conn.execute("PRAGMA journal_mode=WAL")
_session_conn.execute("PRAGMA busy_timeout=20000")
_session_conn.execute(
    """
    CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL DEFAULT '',
        title       TEXT NOT NULL DEFAULT '新会话',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        turns       INTEGER NOT NULL DEFAULT 0
    )
    """
)
_session_conn.execute(
    "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC)"
)
_session_conn.commit()


def _now() -> str:
    # 存 ISO8601（带时区），前端按本地时间格式化
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _row_to_session(row: sqlite3.Row | tuple) -> dict[str, Any]:
    return {
        "id": row[0],
        "user_id": row[1],
        "title": row[2],
        "created_at": row[3],
        "updated_at": row[4],
        "turns": row[5],
    }


def _list_sessions(user_id: str, include_empty: bool = False) -> list[dict[str, Any]]:
    sql = "SELECT id, user_id, title, created_at, updated_at, turns FROM sessions"
    cond: list[str] = []
    args: list[Any] = []
    if user_id:
        cond.append("user_id = ?")
        args.append(user_id)
    if not include_empty:
        cond.append("turns > 0")
    if cond:
        sql += " WHERE " + " AND ".join(cond)
    sql += " ORDER BY updated_at DESC"
    with _session_lock:
        rows = _session_conn.execute(sql, args).fetchall()
    return [_row_to_session(r) for r in rows]


def _get_session(session_id: str) -> dict[str, Any] | None:
    with _session_lock:
        row = _session_conn.execute(
            "SELECT id, user_id, title, created_at, updated_at, turns FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
    return _row_to_session(row) if row else None


def _upsert_session(session_id: str, user_id: str = "", title: str | None = None, turns: int | None = None) -> dict[str, Any]:
    """会话不存在则创建；存在则刷新活跃时间，必要时补标题/轮数。"""
    now = _now()
    with _session_lock:
        row = _session_conn.execute(
            "SELECT id, user_id, title, created_at, updated_at, turns FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()

        if row is None:
            _session_conn.execute(
                "INSERT INTO sessions (id, user_id, title, created_at, updated_at, turns) VALUES (?, ?, ?, ?, ?, ?)",
                (session_id, user_id, (title or "新会话")[:60], now, now, turns or 0),
            )
        else:
            new_title = row[2]
            # 默认标题在有真实提问后自动替换
            if title and (not new_title or new_title == "新会话"):
                new_title = title[:60]
            _session_conn.execute(
                "UPDATE sessions SET title = ?, updated_at = ?, turns = ? WHERE id = ?",
                (new_title, now, turns if turns is not None else row[5], session_id),
            )
        _session_conn.commit()
        row = _session_conn.execute(
            "SELECT id, user_id, title, created_at, updated_at, turns FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
    return _row_to_session(row)


def _create_session(user_id: str, title: str | None = None) -> dict[str, Any]:
    """新建会话，并顺手清掉该用户没有产生过对话的空会话。"""
    with _session_lock:
        stale = _session_conn.execute(
            "SELECT id FROM sessions WHERE user_id = ? AND turns = 0", (user_id,)
        ).fetchall()
        if stale:
            ids = [r[0] for r in stale]
            _session_conn.executemany("DELETE FROM sessions WHERE id = ?", [(i,) for i in ids])
            _session_conn.commit()
    for sid in [r[0] for r in stale]:
        _safe_delete_thread(sid)

    session = _upsert_session(f"s-{uuid.uuid4().hex[:12]}", user_id=user_id, title=title)
    return session


def _safe_delete_thread(thread_id: str) -> None:
    try:
        checkpointer.delete_thread(thread_id)
    except Exception:  # noqa: BLE001 - 会话状态可能本来就不存在
        pass


def _delete_session(session_id: str) -> bool:
    with _session_lock:
        cur = _session_conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        _session_conn.commit()
    _safe_delete_thread(session_id)
    return cur.rowcount > 0


# --------------------------------------------------------------------------- #
# Agent 构建
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=1)
def get_agent():
    """构建 deep agent（进程内单例，对话状态落在 SQLite，重启不丢）。"""
    if not API_KEY:
        raise RuntimeError("未配置 DEEPSEEK_API_KEY，请检查 agent/.env")

    model = ChatDeepSeek(
        model=MODEL_ID,
        api_key=API_KEY,
        api_base=API_BASE,
        temperature=0.3,
        max_tokens=2048,
        timeout=120,
    )
    return create_agent_with(model)


def create_agent_with(model: ChatDeepSeek):
    from deepagents import create_deep_agent

    return create_deep_agent(
        model=model,
        tools=TOOLS,
        system_prompt=SYSTEM_PROMPT,
        checkpointer=checkpointer,
    )


def _config(thread_id: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": thread_id}, "recursion_limit": 60}


# --------------------------------------------------------------------------- #
# 消息解析
# --------------------------------------------------------------------------- #
def _text_of(message: BaseMessage) -> str:
    """把 message.content 统一成纯文本（兼容 str / 多模态块列表）。"""
    content = message.content
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
        return "".join(parts).strip()
    return str(content)


def _tool_calls_of(message: BaseMessage) -> list[dict[str, Any]]:
    raw = getattr(message, "tool_calls", None) or []
    return [
        {"name": call.get("name"), "args": call.get("args", {}), "id": call.get("id")}
        for call in raw
    ]


def _tool_results(messages: list[BaseMessage]) -> dict[str, str]:
    """建立 tool_call_id → 结果文本的映射（并发工具返回顺序不定，必须按 id 配对）。"""
    results: dict[str, str] = {}
    for message in messages:
        if isinstance(message, ToolMessage):
            call_id = getattr(message, "tool_call_id", None)
            if call_id:
                results[call_id] = _text_of(message)
    return results


def _summarize(messages: list[BaseMessage]) -> dict[str, Any]:
    """从完整消息链里提取：最终回答、工具调用轨迹、token 用量。"""
    reply = ""
    tool_trace: list[dict[str, Any]] = []
    tokens = 0
    results = _tool_results(messages)

    for message in messages:
        if isinstance(message, AIMessage):
            tokens += int((getattr(message, "usage_metadata", None) or {}).get("total_tokens", 0))
            for call in _tool_calls_of(message):
                tool_trace.append({**call, "result": results.get(call.get("id") or "", "")})
            text = _text_of(message)
            if text:
                reply = text

    return {"reply": reply, "tool_calls": tool_trace, "total_tokens": tokens}


def _ui_history(messages: list[BaseMessage]) -> list[dict[str, Any]]:
    """把消息链压成前端气泡结构：一轮一个 Agent 气泡，工具调用挂在气泡上。

    前端历史消息与实时流式消息共用同一套渲染路径，所以结构必须一致：
        [{role: "user"|"agent", content: str, tools: [{name, args, result}]}]
    """
    out: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    results = _tool_results(messages)

    for message in messages:
        if isinstance(message, HumanMessage):
            current = None
            out.append({"role": "user", "content": _text_of(message), "tools": []})
        elif isinstance(message, AIMessage):
            if current is None:
                current = {"role": "agent", "content": "", "tools": []}
                out.append(current)
            for call in _tool_calls_of(message):
                current["tools"].append(
                    {
                        "name": call["name"],
                        "args": call.get("args") or {},
                        "result": results.get(call.get("id") or ""),
                    }
                )
            text = _text_of(message)
            if text:
                current["content"] = f"{current['content']}\n\n{text}".strip() if current["content"] else text

    # 去掉既无正文也无工具的空 Agent 气泡
    return [m for m in out if m["role"] == "user" or m["content"] or m["tools"]]


def _sync_session(thread_id: str, messages: list[BaseMessage], user_id: str = "") -> dict[str, Any]:
    """按消息链刷新会话索引（标题取首个提问，轮数取提问次数）。"""
    humans = [m for m in messages if isinstance(m, HumanMessage)]
    title = (_text_of(humans[0]).strip() if humans else "") or "新会话"
    title = " ".join(title.split())[:40]
    return _upsert_session(thread_id, user_id=user_id, title=title, turns=len(humans))


# --------------------------------------------------------------------------- #
# 请求模型
# --------------------------------------------------------------------------- #
class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, description="用户输入")
    thread_id: str = Field("default", description="会话 ID，多轮对话需保持一致")
    user_id: str = Field("", description="所属用户，用于会话列表归属")


class SessionCreate(BaseModel):
    user_id: str = ""
    title: str | None = None


class SessionRename(BaseModel):
    title: str = Field(..., min_length=1)


# --------------------------------------------------------------------------- #
# 路由
# --------------------------------------------------------------------------- #
@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "framework": "deepagents",
        "model": MODEL_ID,
        "api_base": API_BASE,
        "storage": "sqlite",
        "tools": [tool.name for tool in TOOLS],
    }


@app.get("/tools")
def list_tools() -> dict[str, Any]:
    return {
        "tools": [
            {"name": tool.name, "description": (tool.description or "").strip().split("\n")[0]}
            for tool in TOOLS
        ]
    }


@app.get("/whoami")
def whoami(
    x_crm_user: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_context: str = Header(default=""),
) -> dict[str, Any]:
    """回显当前调用者身份（Next 代理注入的 x-crm-* 头）。

    不给模型用，只用于排查「身份是否真的传到了 Agent 侧」。
    """
    ctx: dict[str, Any] = {}
    if x_crm_context:
        padded = x_crm_context + "=" * (-len(x_crm_context) % 4)
        try:
            ctx = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"x-crm-context 解码失败：{exc}") from exc

    return {
        "user": x_crm_user,
        "name": ctx.get("name"),
        "role_name": ctx.get("roleName"),
        "permissions": ctx.get("permissions", []),
        "has_token": bool(x_crm_token),
        "token_length": len(x_crm_token),
    }


@app.get("/sessions")
def get_sessions(user_id: str = "", include_empty: bool = False) -> dict[str, Any]:
    return {"sessions": _list_sessions(user_id, include_empty=include_empty)}


@app.post("/sessions")
def post_session(req: SessionCreate) -> dict[str, Any]:
    return _create_session(req.user_id, req.title)


@app.patch("/sessions/{session_id}")
def patch_session(session_id: str, req: SessionRename) -> dict[str, Any]:
    if _get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    with _session_lock:
        _session_conn.execute(
            "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
            (req.title.strip()[:60], _now(), session_id),
        )
        _session_conn.commit()
    return _get_session(session_id) or {}


@app.delete("/sessions/{session_id}")
def remove_session(session_id: str) -> dict[str, Any]:
    deleted = _delete_session(session_id)
    return {"ok": True, "deleted": deleted, "session_id": session_id}


@app.post("/chat")
def chat(req: ChatRequest) -> dict[str, Any]:
    try:
        agent = get_agent()
        result = agent.invoke(
            {"messages": [HumanMessage(content=req.message)]},
            config=_config(req.thread_id),
        )
    except Exception as exc:  # noqa: BLE001 - 统一转成 502，便于前端展示
        raise HTTPException(status_code=502, detail=f"Agent 执行失败: {exc}") from exc

    messages = result.get("messages", [])
    session = _sync_session(req.thread_id, messages, req.user_id)

    payload = _summarize(messages)
    payload["thread_id"] = req.thread_id
    payload["session"] = session
    return payload


@app.post("/chat/stream")
def chat_stream(req: ChatRequest) -> StreamingResponse:
    def sse(event: dict[str, Any]) -> str:
        return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    def event_source() -> Iterator[str]:
        try:
            agent = get_agent()
            # 同时订阅两种流：
            #   messages → 逐 token 增量，前端可像打字机一样渲染
            #   updates  → 节点级快照，用于拿工具调用与最终文本
            for mode, chunk in agent.stream(
                {"messages": [HumanMessage(content=req.message)]},
                config=_config(req.thread_id),
                stream_mode=["messages", "updates"],
            ):
                if mode == "messages":
                    token, metadata = chunk
                    text = _text_of(token)
                    if text:
                        yield sse(
                            {
                                "node": (metadata or {}).get("langgraph_node"),
                                "type": "token",
                                "content": text,
                                "tool_calls": [],
                            }
                        )
                    continue

                for node, delta in (chunk or {}).items():
                    if not isinstance(delta, dict):
                        continue
                    for message in delta.get("messages", []) or []:
                        if not isinstance(message, BaseMessage):
                            continue
                        event: dict[str, Any] = {
                            "node": node,
                            "type": message.type,
                            "content": _text_of(message),
                            "tool_calls": _tool_calls_of(message),
                        }
                        # 工具结果是并发返回的，带上 id 供前端精确回填
                        if isinstance(message, ToolMessage):
                            event["tool_call_id"] = getattr(message, "tool_call_id", None)
                        yield sse(event)

            # 本轮结束后刷新会话索引（标题 / 轮数 / 活跃时间）
            try:
                state = agent.get_state(_config(req.thread_id))
                messages = (state.values or {}).get("messages", []) if state else []
                session = _sync_session(req.thread_id, messages, req.user_id)
                yield sse({"type": "session", "session": session})
            except Exception as exc:  # noqa: BLE001 - 索引失败不影响本次回答
                yield sse({"type": "warn", "content": f"会话索引更新失败: {exc}"})

            yield "data: [DONE]\n\n"
        except Exception as exc:  # noqa: BLE001 - SSE 内无法改状态码，用事件告知
            error = {"type": "error", "content": f"{exc}"}
            yield f"data: {json.dumps(error, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/threads/{thread_id}")
def thread_history(thread_id: str) -> dict[str, Any]:
    try:
        state = get_agent().get_state(_config(thread_id))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    messages = (state.values or {}).get("messages", []) if state else []
    session = _get_session(thread_id)
    return {
        "thread_id": thread_id,
        "count": len(messages),
        "turns": len([m for m in messages if isinstance(m, HumanMessage)]),
        "session": session,
        "messages": _ui_history(messages),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host="127.0.0.1",
        port=int(os.getenv("AGENT_PORT", "3200")),
        reload=False,
    )
