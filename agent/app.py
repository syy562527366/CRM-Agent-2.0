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
    GET    /threads/{id}       某会话的完整消息历史（前端渲染用，含待审批状态）
    POST   /chat               同步对话（多轮靠 thread_id 维持上下文）
    POST   /chat/stream        SSE 流式对话，逐 token 推送
    POST   /chat/resume        人工审批后恢复被中断的执行（批准 / 拒绝）
"""

from __future__ import annotations

import base64
import json
import os
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator

from deepagents.backends import FilesystemBackend
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_deepseek import ChatDeepSeek
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command
from pydantic import BaseModel, Field

import tools_guard as guard
from crm_client import CrmCtx
from tools import TOOLS as BASE_TOOLS
from tools_crm import CRM_TOOLS
from tools_crm_write import CRM_UPDATE_TOOLS

# 注册给模型的工具：通用工具 + CRM 只读工具 + CRM 修改工具。
# 删除工具（crm_delete_lead / crm_delete_order）**刻意不注册**：
# 产品要求 Agent 不得删除数据，模型看不到工具就不会去调用；
# 即使被误注册，工具入口还有 AGENT_DELETE_ENABLED 兜底。
TOOLS = [*BASE_TOOLS, *CRM_TOOLS, *CRM_UPDATE_TOOLS]

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

MODEL_ID = os.getenv("DEEPSEEK_MODEL", "deepseek-flash")
API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
API_BASE = os.getenv("DEEPSEEK_API_BASE", "https://api.deepseek.com/v1")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.getenv("AGENT_DB_PATH", os.path.join(DATA_DIR, "agent.db"))

SYSTEM_PROMPT = """你是一个严谨、简洁的中文智能助手，运行在本地部署的 DeepAgent 服务中，服务于一套 CRM 系统。

## 数据纪律（最重要）
1. 涉及线索 / 客户 / 订单 / 商品 / 沟通记录 / 统计的问题，必须先调用 crm_* 工具取真实数据，
   严禁凭印象编造客户、金额或条数。
2. 所有数字必须来自工具返回。工具没给的数字不要算、不要猜；需要求和或求占比时调用 calculator。
3. 工具返回 ok=false 时如实转述 message：
   - PERMISSION_DENIED：直接说「当前账号没有 XX 权限」，不得改用其他工具拼凑或推测；
   - FORBIDDEN：说明 Agent 不提供这个能力（例如删除），不要改口说「系统不支持」；
   - INVALID_ARGUMENT：按返回的 options 修正参数重试一次，仍失败就问用户；
   - TIMEOUT / SERVICE_UNAVAILABLE：告诉用户 CRM 服务暂时不可用。
4. 工具返回的 items 是摘要且受 limit 限制，条数要看 total，不要说「一共只有 N 条」。
   需要单个客户的细节时再调 crm_get_lead / crm_get_lead_timeline。
5. 用户说「我的」「我负责的」时不要传 assignee，服务端会按数据范围自动过滤。
6. 手机号等敏感字段只用工具返回的脱敏值，不要尝试还原。

## 写操作纪律（只能修改，不能删除）
可用的写工具只有两个：`crm_update_lead`、`crm_update_order`。

0. **你没有删除能力**。用户说要删线索 / 删订单时，直接回答「我不能删除数据，请在对应列表页
   手动删除」，不要尝试用修改状态来冒充删除，也不要说「系统不支持删除」这种把责任推给系统的话。
   被问到「能不能删」也一样：说明是 Agent 不提供删除能力，需要人工在页面操作。
1. **每次修改都要人工确认**：调用修改工具后，界面会弹出审批卡，用户点「批准」才真正落库。
   调用前用一句话说清要改什么（哪条记录、哪个字段、改成什么），不要长篇解释。
   用户拒绝、或说「先别动」之后，不要重复发起同一处修改，也不要换个工具绕过去。
   审批被拒绝时，如实说「已取消，数据没有改动」。
2. `crm_update_lead` 能改的字段就这些：姓名、电话、客户来源、状态、优先级、负责人、
   意向产品、预算区间、客户定位、试用时长、备注。用户要改的如果在这张表里，就直接改，
   **不要回答「改不了」**；只有确实不在表里（例如线索编号、创建时间、沟通次数）才说明不可改。
   电话是订单的关联键，改号后要提醒用户历史订单仍挂在旧号码上。
3. **目标必须明确**：只有当用户在本轮明确提出要改，且能定位到具体一条记录时才动手。
   能用编号就用编号；用户只给姓名时，工具会返回 AMBIGUOUS 和候选列表，
   这时必须把候选（编号 + 姓名 + 负责人 + 当前状态）列给用户选，**不要自己挑一条，也不要原样重试**。
4. **含糊指令先查后问**：用户说「帮我整理客户」「把没用的线索清一清」这类话时，
   先查询并列出候选，等用户确认具体编号后再改，不要自行判断哪条该动。
5. **一次一条**：不支持批量修改。用户要批量时，说明需要逐条确认，并把清单给出来。
6. **只传要改的字段**：修改类工具没传的参数会保持原值，不要为了「填满」而重复传原值。
7. **结果按实际说**：工具返回的 changed 是真正变化的字段，用「旧值 → 新值」简短汇报（值用中文说，
   例如 low 说「低」、high 说「高」，不要直接念英文枚举）；
   工具报 PERMISSION_DENIED 就直说没有修改权限，不要换工具重试，也不要声称已经改好。
8. 写操作成功后不要重复罗列变更表格（卡片已经展示），一两句话总结即可。

## 回答风格
- 用自然中文先给结论再列要点，不要粘贴原始 JSON。
- 线索 / 订单的明细已经以表格卡片的形式直接展示给用户了，
  正文**不要重复罗列同样的表格**，用一两句话总结要点即可；需要对比或推导时再用 Markdown 表格。
- 控制在 200 字以内，用户要求展开时才详细写。不确定就明说不确定。
- 需要多步任务可用 todo 工具拆解；问时间用 get_current_time，算术用 calculator。

## 线索分析卡片
当用户要求「分析某条线索 / 客户」时，除了给一句简短结论，还要在回答末尾输出一个线索分析卡片，格式为：

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
# 每个账号一个独立工作目录：A 的文件不会被 B 的 ls / read_file 看到
WORKSPACE_DIR = Path(
    os.getenv("AGENT_WORKSPACE_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "workspace"))
)
_WS_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")


def _workspace_name(user_id: str) -> str:
    cleaned = _WS_UNSAFE.sub("_", (user_id or "").strip())[:40]
    return cleaned or "_shared"


@lru_cache(maxsize=16)
def get_agent(workspace: str = "_shared"):
    """构建 deep agent（按工作目录缓存，对话状态落在 SQLite，重启不丢）。"""
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
    return create_agent_with(model, workspace)


def create_agent_with(model: ChatDeepSeek, workspace: str = "_shared"):
    from deepagents import create_deep_agent

    root = WORKSPACE_DIR / workspace
    root.mkdir(parents=True, exist_ok=True)

    # 用 FilesystemBackend 让 ls / read_file / write_file 落到真实磁盘（重启不丢）。
    # virtual_mode=True 把这个目录当成虚拟根：绝对路径和 ".." 都会被挡住，
    # 因此 agent/.env、项目 data/*.json 这些敏感文件读不到。
    backend = FilesystemBackend(root_dir=str(root), virtual_mode=True)

    return create_deep_agent(
        model=model,
        tools=TOOLS,
        system_prompt=SYSTEM_PROMPT,
        checkpointer=checkpointer,
        backend=backend,
        # 修改类工具每次调用都会暂停等人批（approve / reject），
        # 中断点落在 checkpointer 里，进程重启也能接着批。
        interrupt_on=guard.build_interrupt_on(),
    )


def _config(
    thread_id: str,
    ctx: CrmCtx | None = None,
    sink: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """调用者身份与 tool_data 队列都走 configurable —— 模型看不到，也无法伪造。"""
    configurable: dict[str, Any] = {"thread_id": thread_id}
    if ctx is not None:
        configurable["crm_ctx"] = ctx
    if sink is not None:
        configurable["tool_data_sink"] = sink
    return {"configurable": configurable, "recursion_limit": 80}


def _parse_identity(context: str, token: str, user_id: str) -> CrmCtx:
    """把 Next 代理注入的 x-crm-* 头还原成调用者上下文。"""
    return CrmCtx.from_headers(context, token=token, uid=user_id)


def _drain(sink: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """取出本轮已产生的明细卡片并清空队列。"""
    if not sink:
        return []
    cards = list(sink)
    sink.clear()
    return cards


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
def chat(
    req: ChatRequest,
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user or req.user_id)
    config = _config(req.thread_id, ctx)
    try:
        agent = get_agent(_workspace_name(ctx.uid or req.user_id))
        result = agent.invoke(
            {"messages": [HumanMessage(content=req.message)]},
            config=config,
        )
    except Exception as exc:  # noqa: BLE001 - 统一转成 502，便于前端展示
        raise HTTPException(status_code=502, detail=f"Agent 执行失败: {exc}") from exc

    messages = result.get("messages", [])
    session = _sync_session(req.thread_id, messages, ctx.uid or req.user_id)

    payload = _summarize(messages)
    payload["thread_id"] = req.thread_id
    payload["session"] = session
    # 非流式入口遇到修改类工具时也会中断：把待审批内容一并回传，
    # 调用方需要改用 /chat/resume 继续（前端走的是 SSE，不受影响）。
    pending = _pending_approval(agent, config, req.thread_id)
    if pending:
        payload["pending_approval"] = pending
        if not payload.get("reply"):
            payload["reply"] = "这条修改需要人工确认，请调用 /chat/resume 提交决策。"
    return payload


# --------------------------------------------------------------------------- #
# 审批：中断检测 / 恢复
# --------------------------------------------------------------------------- #
def _sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def _interrupts_of(state: Any) -> list[Any]:
    """取出该 thread 上所有待处理的中断（LangGraph 把它们挂在 task 上）。"""
    items: list[Any] = []
    for task in getattr(state, "tasks", None) or ():
        items.extend(getattr(task, "interrupts", None) or ())
    return items


def _pending_approval(agent: Any, config: dict[str, Any], thread_id: str) -> dict[str, Any] | None:
    """该会话是否停在「等人批」。是则返回与 SSE 同构的 approval_required 事件。"""
    try:
        state = agent.get_state(config)
    except Exception:  # noqa: BLE001 - 读不到状态就当没有 pending
        return None
    for item in _interrupts_of(state):
        return guard.build_approval_event(
            getattr(item, "value", None), thread_id, getattr(item, "id", "")
        )
    return None


def _stream_events(
    agent: Any,
    graph_input: Any,
    config: dict[str, Any],
    thread_id: str,
    user_id: str,
    sink: list[dict[str, Any]],
) -> Iterator[str]:
    """把一轮执行翻成 SSE。

    `/chat/stream`（新消息）与 `/chat/resume`（审批后继续）共用这一段，
    保证两条入口的事件协议完全一致，前端只需实现一套渲染。
    """
    paused = False
    try:
        # 同时订阅两种流：
        #   messages → 逐 token 增量，前端可像打字机一样渲染
        #   updates  → 节点级快照，用于拿工具调用、中断与最终文本
        for mode, chunk in agent.stream(graph_input, config=config, stream_mode=["messages", "updates"]):
            if mode == "messages":
                token, metadata = chunk
                # 只把 AI 的正文当 token 推：工具返回（ToolMessage）走下面的 tool 事件，
                # 否则原始 JSON / 英文拒绝语会先闪一下再被正文覆盖。
                if isinstance(token, AIMessage):
                    text = _text_of(token)
                    if text:
                        yield _sse(
                            {
                                "node": (metadata or {}).get("langgraph_node"),
                                "type": "token",
                                "content": text,
                                "tool_calls": [],
                            }
                        )
                continue

            for node, delta in (chunk or {}).items():
                # 中断事件的值是 tuple(Interrupt)，不是 dict。
                # 必须先于 isinstance(delta, dict) 判断处理，否则会被静默丢掉，
                # 表现为「Agent 卡住、没有回复也没有报错」。
                if node == "__interrupt__":
                    items = delta if isinstance(delta, (list, tuple)) else (delta,)
                    for item in items:
                        yield _sse(
                            guard.build_approval_event(
                                getattr(item, "value", None), thread_id, getattr(item, "id", "")
                            )
                        )
                        paused = True
                    continue
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
                    yield _sse(event)

                # 工具执行完后把明细推给前端渲染表格，不进模型上下文
                for card in _drain(sink):
                    yield _sse({"type": "tool_data", **card})
    except Exception as exc:  # noqa: BLE001 - SSE 内无法改状态码，用事件告知
        yield _sse({"type": "error", "content": f"{exc}"})
        return

    # 本轮结束或暂停都要刷新会话索引（标题 / 轮数 / 活跃时间）
    try:
        state = agent.get_state(config)
        messages = (state.values or {}).get("messages", []) if state else []
        session = _sync_session(thread_id, messages, user_id)
        yield _sse({"type": "session", "session": session})
    except Exception as exc:  # noqa: BLE001 - 索引失败不影响本次回答
        yield _sse({"type": "warn", "content": f"会话索引更新失败: {exc}"})

    if paused:
        # 不是结束，是等人：前端据此保留审批卡并禁用输入框
        yield _sse({"type": "paused", "thread_id": thread_id})
    yield "data: [DONE]\n\n"


def _streaming_response(source: Iterator[str]) -> StreamingResponse:
    return StreamingResponse(
        source,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/chat/stream")
def chat_stream(
    req: ChatRequest,
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> StreamingResponse:
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user or req.user_id)
    workspace = _workspace_name(ctx.uid or req.user_id)
    user_id = ctx.uid or req.user_id
    sink: list[dict[str, Any]] = []

    def event_source() -> Iterator[str]:
        try:
            agent = get_agent(workspace)
        except Exception as exc:  # noqa: BLE001
            yield _sse({"type": "error", "content": f"{exc}"})
            return

        config = _config(req.thread_id, ctx, sink)
        # 上一轮还停在审批上，新消息不能在同一个 thread 上跑（LangGraph 会拒绝）
        if _pending_approval(agent, config, req.thread_id):
            yield _sse({"type": "error", "content": guard.PENDING_MESSAGE})
            return

        yield from _stream_events(
            agent,
            {"messages": [HumanMessage(content=req.message)]},
            config,
            req.thread_id,
            user_id,
            sink,
        )

    return _streaming_response(event_source())


class ResumeDecision(BaseModel):
    type: str = Field(..., description="approve（批准）或 reject（拒绝）")
    message: str = Field("", description="拒绝理由，会转给模型作为说明")


class ResumeRequest(BaseModel):
    thread_id: str = Field(..., description="被中断的会话 ID")
    decisions: list[ResumeDecision] = Field(..., description="与 actions 顺序一一对应")
    user_id: str = ""


@app.post("/chat/resume")
def chat_resume(
    req: ResumeRequest,
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> StreamingResponse:
    """人工审批后恢复执行：批准 → 工具真正执行；拒绝 → 工具不执行，模型收到拒绝说明。"""
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user or req.user_id)
    workspace = _workspace_name(ctx.uid or req.user_id)
    user_id = ctx.uid or req.user_id
    sink: list[dict[str, Any]] = []

    decisions = [item.model_dump() for item in req.decisions]
    if not decisions:
        raise HTTPException(status_code=400, detail="decisions 不能为空")
    for item in decisions:
        if item.get("type") not in ("approve", "reject"):
            raise HTTPException(status_code=400, detail=f"不支持的决策类型：{item.get('type')}")

    def event_source() -> Iterator[str]:
        try:
            agent = get_agent(workspace)
        except Exception as exc:  # noqa: BLE001
            yield _sse({"type": "error", "content": f"{exc}"})
            return

        config = _config(req.thread_id, ctx, sink)
        pending = _pending_approval(agent, config, req.thread_id)
        if not pending:
            yield _sse({"type": "error", "content": "这个会话当前没有待审批的操作（可能已经处理过，请刷新会话）"})
            return

        actions = pending.get("actions") or []
        if len(decisions) != len(actions):
            yield _sse(
                {
                    "type": "error",
                    "content": f"待审批 {len(actions)} 项，收到 {len(decisions)} 条决策，请刷新会话后重试",
                }
            )
            return

        # 先留痕再执行：万一执行中断，至少有「谁批了什么」的记录
        guard.record_decisions(ctx, req.thread_id, actions, decisions)
        yield _sse(
            {
                "type": "approval_resolved",
                "thread_id": req.thread_id,
                "decisions": decisions,
            }
        )

        yield from _stream_events(
            agent,
            Command(resume={"decisions": decisions}),
            config,
            req.thread_id,
            user_id,
            sink,
        )

    return _streaming_response(event_source())


@app.get("/threads/{thread_id}")
def thread_history(
    thread_id: str,
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    session = _get_session(thread_id)
    # 会话归属校验：thread_id 是可猜的短串，不能让人拿别人的 ID 读历史
    if session and session.get("user_id") and ctx.uid and session["user_id"] != ctx.uid:
        raise HTTPException(status_code=403, detail="无权查看该会话")

    try:
        agent = get_agent(_workspace_name(ctx.uid or x_crm_user))
        config = _config(thread_id, ctx)
        state = agent.get_state(config)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    messages = (state.values or {}).get("messages", []) if state else []
    return {
        "thread_id": thread_id,
        "count": len(messages),
        "turns": len([m for m in messages if isinstance(m, HumanMessage)]),
        "session": session,
        "messages": _ui_history(messages),
        # 切走 / 刷新回来时用它把审批卡重新渲染出来
        "pending_approval": _pending_approval(agent, config, thread_id),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host="127.0.0.1",
        port=int(os.getenv("AGENT_PORT", "3200")),
        reload=False,
    )
