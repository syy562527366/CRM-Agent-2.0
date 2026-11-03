"""Agent 服务冒烟测试。

前置：服务已启动（python agent/app.py 或 uvicorn app:app --app-dir agent）
运行：agent/.venv/Scripts/python.exe agent/test_agent.py
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import time
from typing import Any

import requests

BASE_URL = "http://127.0.0.1:3200"
TIMEOUT = 180
results: list[tuple[str, bool, str]] = []

# 与 CRM 的 src/lib/auth/session.ts 共用同一套签名规则（本地开发默认密钥）
SESSION_SECRET = os.getenv("CRM_SESSION_SECRET", "crm-local-dev-secret-please-override")

# 销售角色（张明）的权限快照，生产环境这段应由 Next 代理注入，测试里手工模拟
SALES_CTX = {
    "uid": "ACCT-2026-0002",
    "name": "张明",
    "roleId": "ROLE-2026-0002",
    "roleName": "销售",
    "permissions": [
        {"pageKey": "leads", "functions": ["查看", "修改", "增加"], "dataScope": "全部"},
        {"pageKey": "orders", "functions": ["查看", "修改"], "dataScope": "全部"},
        {"pageKey": "products", "functions": ["查看"], "dataScope": "全部"},
        {"pageKey": "communications", "functions": ["查看"], "dataScope": "全部"},
    ],
}


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def crm_headers(ctx: dict[str, Any] = SALES_CTX, ttl: int = 600) -> dict[str, str]:
    """模拟 Next 代理注入的 x-crm-* 头。"""
    body = _b64(
        json.dumps(
            {"uid": ctx["uid"], "rid": ctx["roleId"], "exp": int(time.time()) + ttl}
        ).encode()
    )
    signature = _b64(hmac.new(SESSION_SECRET.encode(), body.encode(), hashlib.sha256).digest())
    return {
        "x-crm-user": ctx["uid"],
        "x-crm-token": f"{body}.{signature}",
        "x-crm-context": _b64(json.dumps(ctx, ensure_ascii=False).encode()),
    }


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} | {name}{' | ' + detail if detail else ''}")


def post_chat(message: str, thread_id: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    resp = requests.post(
        f"{BASE_URL}/chat",
        json={"message": message, "thread_id": thread_id},
        headers=headers or {},
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def main() -> int:
    started = time.time()

    # 1) 健康检查
    try:
        health = requests.get(f"{BASE_URL}/health", timeout=20).json()
        check("健康检查 /health", health.get("status") == "ok", f"model={health.get('model')}")
    except Exception as exc:  # noqa: BLE001
        check("健康检查 /health", False, f"服务未启动？{exc}")
        print("\n服务未启动，测试终止。")
        return 1

    # 2) 基础问答
    try:
        data = post_chat("用一句话说明你是谁，以及你能做什么。", "test-basic")
        reply = data.get("reply", "")
        check("基础问答", len(reply) > 10, f"回复 {len(reply)} 字")
        print(f"      ↳ {reply[:120]}")
    except Exception as exc:  # noqa: BLE001
        check("基础问答", False, str(exc))

    # 3) 工具调用（calculator）
    try:
        data = post_chat("帮我算一下 (128*37+56)/4 等于多少，只要结果。", "test-tool")
        reply = data.get("reply", "")
        used = [c["name"] for c in data.get("tool_calls", [])]
        ok = "1198" in reply.replace(",", "") or "calculator" in used
        check("工具调用 calculator", ok, f"工具={used} 结果={reply[:60]}")
    except Exception as exc:  # noqa: BLE001
        check("工具调用 calculator", False, str(exc))

    # 4) 多轮上下文（同一 thread_id）
    try:
        post_chat("记住暗号：紫罗兰-42。请只回复“已记住”。", "test-memory")
        data = post_chat("我刚才让你记住的暗号是什么？", "test-memory")
        reply = data.get("reply", "")
        check("多轮上下文记忆", "紫罗兰" in reply, f"回复={reply[:60]}")
    except Exception as exc:  # noqa: BLE001
        check("多轮上下文记忆", False, str(exc))

    # 5) 会话历史
    try:
        hist = requests.get(f"{BASE_URL}/threads/test-memory", timeout=30).json()
        check("会话历史 /threads", hist.get("count", 0) >= 4, f"消息数={hist.get('count')}")
    except Exception as exc:  # noqa: BLE001
        check("会话历史 /threads", False, str(exc))

    # 6) 身份头透传：/whoami 应回显代理注入的身份
    headers = crm_headers()
    try:
        me = requests.get(f"{BASE_URL}/whoami", headers=headers, timeout=20).json()
        ok = me.get("name") == "张明" and me.get("role_name") == "销售"
        check("身份头解析 /whoami", ok, f"{me.get('name')} / {me.get('role_name')}")
    except Exception as exc:  # noqa: BLE001
        check("身份头解析 /whoami", False, str(exc))

    # 7) CRM 工具：带身份问线索数量，必须真的调用 crm_* 工具
    try:
        data = post_chat("现在一共有多少条线索？只要总数。", "test-crm-tool", headers=headers)
        used = [c["name"] for c in data.get("tool_calls", [])]
        hit = [name for name in used if name.startswith("crm_")]
        check("CRM 工具调用", bool(hit), f"工具={used} 回复={data.get('reply', '')[:50]}")
    except Exception as exc:  # noqa: BLE001
        check("CRM 工具调用", False, str(exc))

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n===== {passed}/{total} 通过，耗时 {time.time() - started:.1f}s =====")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
