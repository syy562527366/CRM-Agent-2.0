import { NextResponse } from "next/server";
import { clearSession } from "@/lib/auth/session";

/**
 * POST /api/auth/logout - 退出登录（清除会话 Cookie）
 *
 * 前端 localStorage 的清理仍由 AuthContext 负责，这里只负责服务端会话。
 */
export async function POST() {
  return clearSession(NextResponse.json({ ok: true }));
}
