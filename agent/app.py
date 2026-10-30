"""基础 DeepAgent 服务（deepagents + DeepSeek）。

启动：
    agent/.venv/Scripts/python.exe -m uvicorn app:app --app-dir agent --host 127.0.0.1 --port 3200

接口：
    GET  /health          健康检查（含模型信息）
    GET  /tools           已注册工具列表
    GET  /threads/{id}    查看某会话的完整消息历史
    POST /chat            同步对话（多轮靠 thread_id 维持上下文）
    POST /chat/stream     SSE 流式对话，逐节点推送执行过程
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Any, Iterator

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_deepseek import ChatDeepSeek
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import BaseModel, Field

from tools import TOOLS

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

MODEL_ID = os.getenv("DEEPSEEK_MODEL", "deepseek-flash")
API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
API_BASE = os.getenv("DEEPSEEK_API_BASE", "https://api.deepseek.com/v1")

SYSTEM_PROMPT = """你是一个严谨、简洁的中文智能助手，运行在本地部署的 DeepAgent 服务中。

工作要求：
1. 先理解用户目标，需要多步任务时用 todo 工具拆解，再逐项推进。
2. 涉及算术必须调用 calculator 工具，不要心算；涉及“现在几点”必须调用 get_current_time。
3. 工具返回结果后，用自然中文总结结论，不要粘贴原始 JSON。
4. 不确定的信息要明确说明不确定，不要编造。
5. 回答控制在 200 字以内，除非用户要求展开。
"""

app = FastAPI(title="DeepAgent Service", version="0.1.0")


# --------------------------------------------------------------------------- #
# Agent 构建
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=1)
def get_agent():
    """构建 deep agent（进程内单例，checkpointer 放在里面以复用会话历史）。"""
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
        checkpointer=InMemorySaver(),  # 内存版会话持久化，重启后清空
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


def _summarize(messages: list[BaseMessage]) -> dict[str, Any]:
    """从完整消息链里提取：最终回答、工具调用轨迹、token 用量。"""
    reply = ""
    tool_trace: list[dict[str, Any]] = []
    tokens = 0

    for index, message in enumerate(messages):
        if isinstance(message, AIMessage):
            tokens += int((getattr(message, "usage_metadata", None) or {}).get("total_tokens", 0))
            calls = _tool_calls_of(message)
            if calls:
                # 工具调用之后的 ToolMessage 按顺序回填结果
                results = [
                    _text_of(m)
                    for m in messages[index + 1 :]
                    if isinstance(m, ToolMessage)
                ][: len(calls)]
                for call, result in zip(calls, results or [""] * len(calls)):
                    tool_trace.append({**call, "result": result})
            text = _text_of(message)
            if text:
                reply = text

    return {"reply": reply, "tool_calls": tool_trace, "total_tokens": tokens}


# --------------------------------------------------------------------------- #
# 请求模型
# --------------------------------------------------------------------------- #
class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, description="用户输入")
    thread_id: str = Field("default", description="会话 ID，多轮对话需保持一致")


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

    payload = _summarize(result.get("messages", []))
    payload["thread_id"] = req.thread_id
    return payload


@app.post("/chat/stream")
def chat_stream(req: ChatRequest) -> StreamingResponse:
    def event_source() -> Iterator[str]:
        try:
            agent = get_agent()
            for chunk in agent.stream(
                {"messages": [HumanMessage(content=req.message)]},
                config=_config(req.thread_id),
                stream_mode="updates",
            ):
                for node, delta in (chunk or {}).items():
                    if not isinstance(delta, dict):
                        continue
                    for message in delta.get("messages", []) or []:
                        if not isinstance(message, BaseMessage):
                            continue
                        event = {
                            "node": node,
                            "type": message.type,
                            "content": _text_of(message),
                            "tool_calls": _tool_calls_of(message),
                        }
                        yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
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
    return {
        "thread_id": thread_id,
        "count": len(messages),
        "messages": [
            {"role": m.type, "content": _text_of(m), "tool_calls": _tool_calls_of(m)}
            for m in messages
        ],
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host="127.0.0.1",
        port=int(os.getenv("AGENT_PORT", "3200")),
        reload=False,
    )
