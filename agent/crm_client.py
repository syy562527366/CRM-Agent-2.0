"""CRM HTTP 客户端与调用者身份解析。

Agent **不直接读** `data/*.json`：权限、数据范围、脱敏只在 CRM 侧实现一次，
以后换存储（JSON → SQLite → Postgres）也不用改工具代码。

身份来自 Next 代理注入的请求头（服务端写入，浏览器与模型都改不了）：

    x-crm-user     账号 ID
    x-crm-token    签名会话 token → Authorization: Bearer <token>
    x-crm-context  base64url(JSON)：uid / name / roleId / roleName / permissions
"""

from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass, field
from typing import Any

import httpx

CRM_BASE_URL = os.getenv("CRM_BASE_URL", "http://127.0.0.1:3100").rstrip("/")
CRM_TIMEOUT = float(os.getenv("CRM_TIMEOUT", "5"))


# --------------------------------------------------------------------------- #
# 调用者身份
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class CrmCtx:
    """一次对话的调用者上下文。只能由代理头解析而来，模型无法伪造。"""

    uid: str = ""
    name: str = ""
    role_id: str = ""
    role_name: str = ""
    token: str = ""
    permissions: tuple[dict[str, Any], ...] = field(default_factory=tuple)

    @classmethod
    def from_headers(cls, context: str, token: str = "", uid: str = "") -> "CrmCtx":
        """解码 x-crm-context；解不出来就退化成「无身份」，工具会统一拒绝。"""
        payload: dict[str, Any] = {}
        if context:
            padded = context + "=" * (-len(context) % 4)
            try:
                payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
            except Exception:  # noqa: BLE001 - 头被篡改或截断，按无身份处理
                payload = {}

        perms = payload.get("permissions") or []
        return cls(
            uid=str(payload.get("uid") or uid or ""),
            name=str(payload.get("name") or ""),
            role_id=str(payload.get("roleId") or ""),
            role_name=str(payload.get("roleName") or ""),
            token=token or "",
            permissions=tuple(p for p in perms if isinstance(p, dict)),
        )

    # -- 权限判定（与 CRM 侧同一套 pageKey / 功能 / 数据范围） --------------- #
    def permission(self, page_key: str) -> dict[str, Any] | None:
        for item in self.permissions:
            if item.get("pageKey") == page_key:
                return item
        return None

    def can(self, page_key: str, action: str = "查看") -> bool:
        perm = self.permission(page_key)
        return bool(perm) and action in (perm.get("functions") or [])

    def own_only(self, page_key: str) -> bool:
        perm = self.permission(page_key)
        return bool(perm) and perm.get("dataScope") == "仅自己"

    @property
    def is_anonymous(self) -> bool:
        return not self.uid


# --------------------------------------------------------------------------- #
# 返回信封：工具统一返回它，模型不用猜成功/失败
# --------------------------------------------------------------------------- #
def ok(**fields: Any) -> dict[str, Any]:
    return {"ok": True, **fields}


def fail(error: str, message: str, **fields: Any) -> dict[str, Any]:
    return {"ok": False, "error": error, "message": message, **fields}


def dump(envelope: dict[str, Any]) -> str:
    return json.dumps(envelope, ensure_ascii=False)


# --------------------------------------------------------------------------- #
# 客户端
# --------------------------------------------------------------------------- #
_ERROR_MAP = {
    401: ("UNAUTHORIZED", "登录状态已失效，请让用户重新登录 CRM 后再试"),
    403: ("PERMISSION_DENIED", "当前账号没有该数据的查看权限"),
    404: ("NOT_FOUND", "记录不存在，或不在当前账号的数据范围内"),
}


def _clean(params: dict[str, Any] | None) -> dict[str, Any]:
    """去掉空值，避免把 status="" 这类垃圾参数发给 CRM。"""
    if not params:
        return {}
    return {k: v for k, v in params.items() if v not in (None, "", [], ())}


class CrmClient:
    """薄封装：只做「发请求 + 错误映射」，业务语义留给各个工具。"""

    def __init__(self, ctx: CrmCtx):
        self.ctx = ctx
        headers = {"Accept": "application/json"}
        if ctx.token:
            headers["Authorization"] = f"Bearer {ctx.token}"
        self._client = httpx.Client(
            base_url=CRM_BASE_URL,
            timeout=CRM_TIMEOUT,
            headers=headers,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "CrmClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """成功返回 {'ok': True, 'body': {...}}，失败返回 fail(...)。"""
        try:
            resp = self._client.get(path, params=_clean(params))
        except httpx.TimeoutException:
            return fail("TIMEOUT", f"CRM 服务响应超时（>{CRM_TIMEOUT:g}s），请稍后再试")
        except httpx.HTTPError as exc:
            return fail("SERVICE_UNAVAILABLE", f"无法连接 CRM 服务（{CRM_BASE_URL}）：{exc}")

        if resp.status_code == 200:
            try:
                return {"ok": True, "body": resp.json()}
            except ValueError:
                return fail("BAD_RESPONSE", "CRM 返回的不是合法 JSON")

        code, default = _ERROR_MAP.get(
            resp.status_code, ("HTTP_ERROR", f"CRM 返回 {resp.status_code}")
        )
        detail = default
        try:
            detail = resp.json().get("error") or default
        except ValueError:
            pass
        return fail(code, detail, status=resp.status_code)

    def list(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """分页列表接口的便捷取数：{'ok': True, 'items': [...], 'total': n}。"""
        result = self.get(path, params)
        if not result["ok"]:
            return result
        body = result["body"] or {}
        items = body.get("data")
        if not isinstance(items, list):
            items = body if isinstance(body, list) else []
        return {"ok": True, "items": items, "total": int(body.get("total") or len(items))}


def mask_phone(phone: str | None) -> str:
    """手机号脱敏：13812345678 → 138****5678。"""
    if not phone:
        return ""
    phone = str(phone)
    if len(phone) < 7:
        return "*" * len(phone)
    return f"{phone[:3]}****{phone[-4:]}"


def mask_id_card(value: str | None) -> str:
    if not value:
        return ""
    value = str(value)
    if len(value) <= 6:
        return "*" * len(value)
    return f"{value[:3]}{'*' * (len(value) - 6)}{value[-3:]}"
