"""基础 DeepAgent 服务（deepagents + DeepSeek）。

启动：
    agent/.venv/Scripts/python.exe -m uvicorn app:app --app-dir agent --host 127.0.0.1 --port 3200

接口：
    GET    /health             健康检查（含模型信息 / 运行时长 / 配置版本）
    GET    /tools              已注册工具列表
    GET    /skills             已加载的 Skill 列表与校验结果（仅管理员）
    GET    /skills/{name}      单篇技能的 SKILL.md 原文（仅管理员）
    PUT    /skills/{name}      覆写 SKILL.md，写盘前校验（仅管理员）
    POST   /skills/{name}/toggle  启用 / 关闭技能（移动目录，仅管理员）
    POST   /skills/reload      清空 Agent 实例缓存，强制重读技能目录（仅管理员）
    GET    /kb/documents       知识库文档清单 + 库统计（仅管理员）
    GET    /kb/documents/{id}/chunks  单篇文档的切块明细（仅管理员）
    POST   /kb/upload          上传知识库文件，异步解析 / 向量化 / 挂载（仅管理员）
    GET    /kb/jobs            上传任务进度，供前端轮询（仅管理员）
    DELETE /kb/documents/{id}  删除一篇知识库文档（仅管理员）
    GET    /config             Agent 配置（提示词 + 工具开关 + 权限，仅管理员）
    PUT    /config             部分更新配置（提示词 / 工具开关 / 权限，仅管理员）
    POST   /config/reset       恢复出厂配置（仅管理员）
    POST   /config/test-model  模型连通性测试（仅管理员）
    GET    /metrics/overview   调用指标：今日 / 昨日 / 7 日趋势 / 工具榜（仅管理员）
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
import logging
import os
import re
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_deepseek import ChatDeepSeek
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command
from pydantic import BaseModel, Field

import agent_config as cfg
import metrics
import skills_store
import tools_guard as guard
from crm_client import CrmCtx
from tools import TOOLS as BASE_TOOLS
from tools_crm import CRM_TOOLS
from tools_crm_write import CRM_UPDATE_TOOLS
from tools_kb import KB_TOOLS

# 可注册给模型的工具池：通用工具 + 知识库检索 + CRM 只读工具 + CRM 修改工具。
# 删除工具（crm_delete_lead / crm_delete_order）**刻意不在池子里**：
# 产品要求 Agent 不得删除数据，模型看不到工具就不会去调用；
# 即使被误注册，工具入口还有 AGENT_DELETE_ENABLED 兜底。
# 运行时还会按「Agent 控制面板」的开关再过滤一次（见 _build_agent）。
TOOLS = [*BASE_TOOLS, *KB_TOOLS, *CRM_TOOLS, *CRM_UPDATE_TOOLS]

STARTED_AT = time.time()

logger = logging.getLogger("agent")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

MODEL_ID = os.getenv("DEEPSEEK_MODEL", "deepseek-flash")
API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
API_BASE = os.getenv("DEEPSEEK_API_BASE", "https://api.deepseek.com/v1")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.getenv("AGENT_DB_PATH", os.path.join(DATA_DIR, "agent.db"))

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


def get_agent(workspace: str = "_shared"):
    """按「工作目录 + 当前配置版本」构建 deep agent。

    配置（提示词 / 工具开关 / 权限）改完立刻生效：revision 变了就是新的缓存键，
    旧实例留在 LRU 里等待淘汰，不影响已在进行中的请求。
    """
    return _build_agent(workspace, cfg.revision())


@lru_cache(maxsize=32)
def _build_agent(workspace: str, revision: str):
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

    # 复合后端：
    #   /skills/  → agent/skills/（产品级技能，所有账号共用同一份，跟 git 走）
    #   其余路径   → agent/workspace/<uid>/（本账号私有草稿区）
    # 两边都是 virtual_mode=True：绝对路径与 ".." 会被拒，
    # 因此 agent/.env、项目 data/*.json 这些敏感文件读不到。
    backend = skills_store.build_backend(root)

    enabled = cfg.effective_tool_names()
    approval = cfg.approval_tool_names()

    return create_deep_agent(
        model=model,
        # 控制面板关掉的工具不进这个列表 —— 模型连工具名都看不到，
        # 比「提示词劝它别用」可靠得多。
        tools=[tool for tool in TOOLS if tool.name in enabled],
        system_prompt=cfg.current_prompt(),
        checkpointer=checkpointer,
        backend=backend,
        # Skill 能力：只把已通过校验的技能目录交给框架。
        # 框架只把 name + description 注入提示词，模型需要时自己 read_file 取全文。
        skills=[skills_store.SKILLS_ROUTE],
        # 权限=人工审批 的工具每次调用都会暂停等人批（approve / reject），
        # 中断点落在 checkpointer 里，进程重启也能接着批。
        interrupt_on=guard.build_interrupt_on(approval),
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


def _turn_input(message: str) -> dict[str, Any]:
    """一轮对话的初始状态。

    `skills_metadata=None` 是框架约定的「请重读技能目录」信号：
    技能文件新增 / 修改 / 删除后，下一句话就生效，不用新建会话，
    也不会因为某个 thread 早先缓存过技能列表就看不到新技能。
    """
    return {"messages": [HumanMessage(content=message)], "skills_metadata": None}


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


def _track_usage(store: dict[str, tuple[int, int, int]], message: BaseMessage) -> None:
    """累加 token 用量，按消息 id 去重。

    流式下同一条 AI 消息会切成很多 chunk，DeepSeek 只在最后一块带 usage，
    但不同版本也可能每块都带（且是累计值）。所以按 id 取「最大值」而不是相加，
    否则 token 会翻好几倍。
    """
    usage = getattr(message, "usage_metadata", None)
    if not isinstance(usage, dict):
        return
    total = int(usage.get("total_tokens") or 0)
    if total <= 0:
        return
    key = str(getattr(message, "id", "") or "stream")
    prompt = int(usage.get("input_tokens") or 0)
    completion = int(usage.get("output_tokens") or 0)
    previous = store.get(key)
    if previous is None or total >= previous[2]:
        store[key] = (prompt, completion, total)


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
    enabled = cfg.effective_tool_names()
    skills_all = skills_store.list_skills()
    return {
        "status": "ok",
        "framework": "deepagents",
        "model": MODEL_ID,
        "api_base": API_BASE,
        "storage": "sqlite",
        "uptime_s": int(time.time() - STARTED_AT),
        "started_at": datetime.fromtimestamp(STARTED_AT).astimezone().isoformat(timespec="seconds"),
        "config_revision": cfg.revision(),
        # 这里回的是「模型实际能用的工具」，关掉的不会出现 —— 便于一眼确认配置生效
        "tools": [tool.name for tool in TOOLS if tool.name in enabled],
        "tools_total": len(TOOLS),
        # 技能同理：只列「启用且通过校验」的，关闭的与坏掉的在 /skills 里带开关 / errors
        "skills": [item["name"] for item in skills_all if item["valid"] and item["enabled"]],
        "skills_total": len(skills_all),
        "skills_disabled": sum(1 for item in skills_all if not item["enabled"]),
        "kb": _kb_status(),
    }


# 知识库状态缓存：每 30s 才真查一次。health 会被监控高频轮询，
# 每次都开 SQLite + 加载扩展没必要。
_kb_cache: dict[str, Any] = {"at": 0.0, "value": {}}


def _kb_status() -> dict[str, Any]:
    now = time.time()
    if now - _kb_cache["at"] < 30 and _kb_cache["value"]:
        return _kb_cache["value"]

    try:
        from kb.config import load_config as load_kb_config
        from kb.store import KBStore

        kb_cfg = load_kb_config()
        if not kb_cfg.db_path.exists():
            value: dict[str, Any] = {"ready": False, "reason": "尚未初始化，执行 python -m kb.cli init"}
        else:
            with KBStore(kb_cfg) as store:
                st = store.stats()
            value = {
                "ready": True,
                "docs": st["docs"],
                "chunks": st["chunks"],
                "dim": st["dim"],
                "model": st["model"],
            }
    except Exception as exc:  # noqa: BLE001 - 健康检查不能因为知识库挂了就 500
        value = {"ready": False, "reason": f"{type(exc).__name__}: {exc}"[:160]}

    _kb_cache.update(at=now, value=value)
    return value


def _require_admin(ctx: CrmCtx) -> None:
    """控制面板是管理员功能。前端隐藏入口只是体验，这里才是边界。"""
    if not cfg.can_manage(ctx):
        raise HTTPException(status_code=403, detail="只有系统管理员可以管理 Agent 配置")


@app.get("/config")
def get_config(
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)
    return cfg.view()


class ConfigUpdate(BaseModel):
    system_prompt: str | None = Field(None, description="新的系统提示词；不传表示不改")
    tools: dict[str, dict[str, Any]] | None = Field(
        None, description='工具覆盖项，例如 {"crm_update_lead": {"enabled": true, "permission": "approval"}}'
    )


@app.put("/config")
def put_config(
    req: ConfigUpdate,
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)
    if req.system_prompt is None and not req.tools:
        raise HTTPException(status_code=400, detail="没有要更新的内容")

    try:
        return cfg.save(
            system_prompt=req.system_prompt,
            tools=req.tools,
            updated_by=ctx.name or ctx.uid,
        )
    except cfg.ConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/config/reset")
def post_config_reset(
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)
    return cfg.reset(updated_by=ctx.name or ctx.uid)


@app.post("/config/test-model")
def post_test_model(
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    """发一次最小请求验证模型连通性。返回体量小，够判断通不通、有多快。"""
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)
    if not API_KEY:
        return {"ok": False, "message": "未配置 DEEPSEEK_API_KEY", "model": MODEL_ID}

    probe = ChatDeepSeek(
        model=MODEL_ID,
        api_key=API_KEY,
        api_base=API_BASE,
        temperature=0,
        max_tokens=16,
        timeout=20,
    )
    started = time.perf_counter()
    try:
        reply = probe.invoke("连通性测试，请只回复：pong")
    except Exception as exc:  # noqa: BLE001 - 连通性失败要把原因原样给管理员
        return {
            "ok": False,
            "model": MODEL_ID,
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "message": str(exc)[:300],
        }

    usage = getattr(reply, "usage_metadata", None) or {}
    return {
        "ok": True,
        "model": MODEL_ID,
        "latency_ms": int((time.perf_counter() - started) * 1000),
        "reply": _text_of(reply)[:80],
        "total_tokens": int(usage.get("total_tokens") or 0),
        "checked_at": _now(),
    }


@app.get("/metrics/overview")
def get_metrics(
    days: int = 7,
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)
    data = metrics.overview(days=min(max(days, 1), 30))
    data["model"] = MODEL_ID
    return data


@app.get("/tools")
def list_tools() -> dict[str, Any]:
    return {
        "tools": [
            {"name": tool.name, "description": (tool.description or "").strip().split("\n")[0]}
            for tool in TOOLS
        ]
    }


@app.get("/skills")
def get_skills(
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    """技能清单与校验结果。

    返回 `valid=false` 的技能不会进 Agent —— 写坏了只会在控制面板报警，
    不会污染模型上下文。排查「为什么模型没看到我的技能」先看这里。
    """
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)
    return skills_store.summary()


@app.post("/skills/reload")
def post_skills_reload(
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    """清空 Agent 实例缓存并重扫技能目录。

    正常改技能内容不需要调这个：每轮对话都会以 `skills_metadata=None` 触发重读，
    保存文件后下一句话就生效。只有改了 `AGENT_SKILLS_DIR` 之类的路径配置，
    或者怀疑缓存没刷新时才需要显式重载。
    """
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)
    _build_agent.cache_clear()
    return {"ok": True, "reloaded_by": ctx.name or ctx.uid, **skills_store.summary()}


@app.get("/skills/{name}")
def get_skill_detail(
    name: str,
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    """单篇技能的 SKILL.md 原文，供「Skill 管理」的编辑弹窗使用。"""
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)
    try:
        return {"ok": True, "skill": skills_store.read_skill(name)}
    except skills_store.SkillError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


class SkillSaveReq(BaseModel):
    content: str = Field(..., min_length=1, max_length=200_000, description="SKILL.md 全文")


@app.put("/skills/{name}")
def put_skill(
    name: str,
    req: SkillSaveReq,
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    """覆写 SKILL.md。

    写盘前按与启动时同一套规则校验（frontmatter 齐全、`name` 等于目录名、
    正文非空），校验不过直接 400 且**不落盘** —— 否则控制面板里改错一处，
    技能立刻变 invalid，模型下一轮就丢掉它，现场还被覆盖了。

    保存后清 Agent 缓存：下一句话就按新内容执行，不用重启服务。
    """
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)
    try:
        skill = skills_store.save_skill(name, req.content)
    except skills_store.SkillError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    _build_agent.cache_clear()
    logger.info("技能已更新 name=%s by=%s bytes=%s", name, ctx.uid, len(req.content))
    return {"ok": True, "skill": skill, "updated_by": ctx.name or ctx.uid, **skills_store.summary()}


class SkillToggleReq(BaseModel):
    enabled: bool


@app.post("/skills/{name}/toggle")
def post_skill_toggle(
    name: str,
    req: SkillToggleReq,
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    """启用 / 关闭技能。

    实现是**移动目录**（`skills/` ↔ `skills-disabled/`）：框架的 SkillsMiddleware
    只扫来源目录顶层，没有开关参数，目录留在原地就仍会注入提示词、仍能被
    `read_file` 读到。「移出去」才是真的不可用 —— 关闭后模型既看不到它的
    name/description，也读不到正文。
    """
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)
    try:
        skill = skills_store.set_enabled(name, req.enabled)
    except skills_store.SkillError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    _build_agent.cache_clear()
    logger.info("技能%s name=%s by=%s", "启用" if req.enabled else "关闭", name, ctx.uid)
    return {
        "ok": True,
        "skill": skill,
        "changed_by": ctx.name or ctx.uid,
        **skills_store.summary(),
    }


@app.get("/kb/documents")
def kb_documents(
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    """知识库管理页的数据源：库统计 + 已挂载文档清单。"""
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)

    try:
        from kb.config import load_config as load_kb_config
        from kb.store import KBStore

        kb_cfg = load_kb_config()
        if not kb_cfg.db_path.exists():
            return {"ready": False, "reason": "知识库尚未初始化", "stats": None, "docs": [], "jobs": []}

        with KBStore(kb_cfg) as store:
            stats = store.stats()
            docs = store.list_documents()

        from kb import jobs as kb_jobs

        return {
            "ready": True,
            "stats": stats,
            "docs": docs,
            "jobs": kb_jobs.list_jobs(limit=10),
            "running": kb_jobs.has_running(),
        }
    except Exception as exc:  # noqa: BLE001 - 页面要能显示原因，而不是整页崩
        return {
            "ready": False,
            "reason": f"{type(exc).__name__}: {exc}"[:200],
            "stats": None,
            "docs": [],
            "jobs": [],
            "running": False,
        }


@app.get("/kb/documents/{doc_id}/chunks")
def kb_document_chunks(
    doc_id: int,
    limit: int = 500,
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    """单篇文档的切块明细，供管理页抽屉查看「切完之后长什么样」。

    正文直接取 kb_chunks.content —— 向量没法反解成文本，能给人看的就是入库
    时那段切块原文。单块上限 700 字（chunker 默认），一次返回整篇没有压力；
    limit 只是兜底，正常文档远到不了 500 块。
    """
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)

    from kb.config import load_config as load_kb_config
    from kb.store import KBStore

    capped = max(1, min(limit, 2000))
    with KBStore(load_kb_config()) as store:
        doc = store.get_document(doc_id)
        if doc is None:
            raise HTTPException(status_code=404, detail=f"文档不存在：#{doc_id}")
        chunks = store.list_chunks(doc_id, limit=capped)

    return {
        "ok": True,
        "doc": doc,
        "chunks": chunks,
        "total": doc["chunks"],
        "truncated": len(chunks) < doc["chunks"],
    }


class KbUploadReq(BaseModel):
    filename: str = Field(..., min_length=1, max_length=200)
    content_base64: str = Field(..., min_length=1, description="文件内容的 base64")


@app.post("/kb/upload")
def kb_upload(
    req: KbUploadReq,
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    """上传知识库文件，异步解析 + 向量化 + 挂载。

    为什么用 base64 JSON 而不是 multipart：`/agent-api/*` 那层代理统一按
    JSON 透传（`content-type: application/json`），multipart 过不去。
    知识库文件都是几十 KB 的文本/表格，base64 膨胀 33% 也无所谓。

    立即返回 job_id，前端轮询 `/kb/jobs` 看进度 —— embedding 是秒级操作，
    同步等会让上传按钮转圈十几秒，看起来像卡死。
    """
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)

    from kb import jobs as kb_jobs
    from kb.upload import MAX_UPLOAD_BYTES, UploadError, check_ext, normalize_filename

    try:
        name = normalize_filename(req.filename)
        check_ext(name)
    except UploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # base64 比原文长 4/3，先按编码后长度挡一次，避免为超大文件白解码
    if len(req.content_base64) > MAX_UPLOAD_BYTES * 4 // 3 + 1024:
        raise HTTPException(
            status_code=413,
            detail=f"文件超过 {MAX_UPLOAD_BYTES // 1024 // 1024} MB 上限",
        )

    try:
        data = base64.b64decode(req.content_base64, validate=True)
    except Exception as exc:  # noqa: BLE001 - 非法 base64 统一按参数错误返回
        raise HTTPException(status_code=400, detail="文件内容不是合法的 base64") from exc

    if not data:
        raise HTTPException(status_code=400, detail="文件是空的")

    job = kb_jobs.submit(name, data, on_done=_invalidate_kb_cache)
    logger.info("知识库上传任务已创建 job=%s file=%s bytes=%s by=%s", job["job_id"], name, len(data), ctx.uid)
    return {"ok": True, "job": job}


@app.get("/kb/jobs")
def kb_jobs_list(
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    """上传统计进度：轮询这个接口刷新进度条。"""
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)

    from kb import jobs as kb_jobs

    return {"jobs": kb_jobs.list_jobs(limit=10), "running": kb_jobs.has_running()}


@app.delete("/kb/documents/{doc_id}")
def kb_delete_document(
    doc_id: int,
    x_crm_context: str = Header(default=""),
    x_crm_token: str = Header(default=""),
    x_crm_user: str = Header(default=""),
) -> dict[str, Any]:
    """删除一篇已挂载文档（连同切块与向量）。

    只提供删除、不提供修改：改内容等于重新向量化，直接让用户重新上传同名文件
    更可控（doc_key 相同会原地替换），也避免「改了一半」的半成品文档。
    """
    ctx = _parse_identity(x_crm_context, x_crm_token, x_crm_user)
    _require_admin(ctx)

    from kb.config import load_config as load_kb_config
    from kb.store import KBStore

    with KBStore(load_kb_config()) as store:
        if not store.delete_document_by_id(doc_id):
            raise HTTPException(status_code=404, detail=f"文档不存在：#{doc_id}")
        stats = store.stats()

    from kb import jobs as kb_jobs

    kb_jobs.forget_document(doc_id)
    _invalidate_kb_cache()
    logger.info("知识库文档已删除 doc_id=%s by=%s", doc_id, ctx.uid)
    return {"ok": True, "doc_id": doc_id, "stats": stats}


def _invalidate_kb_cache() -> None:
    """清掉 /health 里 30 秒的知识库统计缓存。

    上传/删除后如果不清，健康卡片要过一会儿才跳数字，
    看起来像「操作没生效」。
    """
    _kb_cache["at"] = 0.0


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
    started_at = time.perf_counter()
    try:
        agent = get_agent(_workspace_name(ctx.uid or req.user_id))
        result = agent.invoke(
            _turn_input(req.message),
            config=config,
        )
    except Exception as exc:  # noqa: BLE001 - 统一转成 502，便于前端展示
        # 堆栈只进服务端日志：前端要的是人能看懂的一句话，
        # 排障要的是完整 traceback，两边别混在一起。
        logger.exception("chat 执行失败 thread=%s uid=%s", req.thread_id, ctx.uid or req.user_id)
        metrics.record(
            duration_ms=int((time.perf_counter() - started_at) * 1000),
            uid=ctx.uid or req.user_id,
            thread_id=req.thread_id,
            entry="chat",
            model=MODEL_ID,
            ok=False,
            error=str(exc),
        )
        raise HTTPException(status_code=502, detail=f"Agent 执行失败: {exc}") from exc

    messages = result.get("messages", [])
    session = _sync_session(req.thread_id, messages, ctx.uid or req.user_id)

    payload = _summarize(messages)
    metrics.record(
        duration_ms=int((time.perf_counter() - started_at) * 1000),
        uid=ctx.uid or req.user_id,
        thread_id=req.thread_id,
        entry="chat",
        total_tokens=int(payload.get("total_tokens") or 0),
        tools=[str(call.get("name") or "") for call in payload.get("tool_calls") or []],
        model=MODEL_ID,
        ok=True,
    )
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
    *,
    entry: str = "chat",
    started_at: float | None = None,
    ctx: CrmCtx | None = None,
) -> Iterator[str]:
    """把一轮执行翻成 SSE。

    `/chat/stream`（新消息）与 `/chat/resume`（审批后继续）共用这一段，
    保证两条入口的事件协议完全一致，前端只需实现一套渲染。
    结束时把耗时 / token / 工具调用记进 `chat_metrics`（控制面板的数据来源）。
    """
    paused = False
    ok = True
    error_text = ""
    usage: dict[str, tuple[int, int, int]] = {}
    called: list[str] = []

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
                    _track_usage(usage, token)
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
                    if isinstance(message, AIMessage):
                        _track_usage(usage, message)
                        for call in _tool_calls_of(message):
                            name = str(call.get("name") or "")
                            if name:
                                called.append(name)
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
        ok, error_text = False, str(exc)
        logger.exception("stream 执行失败 thread=%s uid=%s", thread_id, getattr(ctx, "uid", "") or user_id)
        yield _sse({"type": "error", "content": f"{exc}"})
        return
    finally:
        prompt_tokens = sum(item[0] for item in usage.values())
        completion_tokens = sum(item[1] for item in usage.values())
        total_tokens = sum(item[2] for item in usage.values())
        metrics.record(
            duration_ms=int((time.perf_counter() - started_at) * 1000) if started_at else 0,
            uid=getattr(ctx, "uid", "") or user_id,
            thread_id=thread_id,
            entry=entry,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            tools=called,
            model=MODEL_ID,
            ok=ok,
            error=error_text,
        )

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
    started_at = time.perf_counter()

    def event_source() -> Iterator[str]:
        try:
            agent = get_agent(workspace)
        except Exception as exc:  # noqa: BLE001
            metrics.record(
                duration_ms=int((time.perf_counter() - started_at) * 1000),
                uid=user_id,
                thread_id=req.thread_id,
                entry="chat",
                model=MODEL_ID,
                ok=False,
                error=str(exc),
            )
            yield _sse({"type": "error", "content": f"{exc}"})
            return

        config = _config(req.thread_id, ctx, sink)
        # 上一轮还停在审批上，新消息不能在同一个 thread 上跑（LangGraph 会拒绝）
        if _pending_approval(agent, config, req.thread_id):
            yield _sse({"type": "error", "content": guard.PENDING_MESSAGE})
            return

        yield from _stream_events(
            agent,
            _turn_input(req.message),
            config,
            req.thread_id,
            user_id,
            sink,
            entry="chat",
            started_at=started_at,
            ctx=ctx,
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

    started_at = time.perf_counter()
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
            entry="resume",
            started_at=started_at,
            ctx=ctx,
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
