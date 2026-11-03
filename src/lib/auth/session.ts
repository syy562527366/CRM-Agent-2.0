import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { findAccount } from "@/lib/crm/accounts";
import { findRole } from "@/lib/crm/roles";
import { buildScope, can, type CrmAction, type CrmScope } from "@/lib/crm/scope";

/**
 * 服务端会话。
 *
 * 旧实现的 token 只是 `base64(账号ID:时间戳)`，不签名、也没人校验，等于没有鉴权。
 * 这里改用 HMAC-SHA256 签名 + HttpOnly Cookie：
 * - 浏览器自动携带，前端 fetch 无需改动；
 * - 签名保证客户端改不了 uid / rid；
 * - HttpOnly 降低 XSS 后会话被盗的风险。
 */

export const SESSION_COOKIE = "crm_session";

const DEV_SECRET = "crm-local-dev-secret-please-override";
const TTL_SECONDS = 60 * 60 * 12; // 12 小时

function secret(): string {
  return process.env.CRM_SESSION_SECRET || DEV_SECRET;
}

interface SessionPayload {
  uid: string;
  rid: string;
  exp: number;
}

function sign(body: string): string {
  return crypto.createHmac("sha256", secret()).update(body).digest("base64url");
}

function encode(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function createToken(accountId: string, roleId: string, ttlSeconds = TTL_SECONDS): string {
  return encode({
    uid: accountId,
    rid: roleId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

export function verifyToken(token: string | null | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = sign(body);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as SessionPayload;
    if (!payload?.uid || !payload?.rid) return null;
    if (payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 优先读 Cookie，其次兼容 Authorization: Bearer（方便 Agent 服务/脚本调用） */
export function readToken(request: NextRequest): string | null {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (cookie) return cookie;
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return null;
}

export function withSession(response: NextResponse, token: string): NextResponse {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: TTL_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}

export function clearSession(response: NextResponse): NextResponse {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}

export type AuthResult =
  | { ok: true; scope: CrmScope }
  | { ok: false; response: NextResponse };

function unauthorized(message: string, status = 401): AuthResult {
  return { ok: false, response: NextResponse.json({ error: message }, { status }) };
}

/** 校验会话并加载账号/角色；账号被删或角色变更都会在这里反映出来 */
export function authenticate(request: NextRequest): AuthResult {
  const payload = verifyToken(readToken(request));
  if (!payload) return unauthorized("登录已失效，请重新登录");

  const account = findAccount(payload.uid);
  if (!account) return unauthorized("账号不存在或已被删除");

  const role = findRole(payload.rid) ?? findRole(account.roleId) ?? null;
  return { ok: true, scope: buildScope(account, role) };
}

/** 会话 + 功能权限双重校验 */
export function authorize(request: NextRequest, pageKey: string, action: CrmAction): AuthResult {
  const auth = authenticate(request);
  if (!auth.ok) return auth;
  if (!can(auth.scope, pageKey, action)) {
    return unauthorized(`当前角色无「${pageKey} · ${action}」权限`, 403);
  }
  return auth;
}
