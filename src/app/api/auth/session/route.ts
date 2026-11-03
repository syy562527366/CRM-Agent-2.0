import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/session";
import { findAccount, toSafeAccount } from "@/lib/crm/accounts";

/**
 * GET /api/auth/session - 当前会话
 *
 * 前端启动时用它校验 Cookie 是否有效，并同步最新的角色权限
 * （管理员改过权限后，用户刷新页面即可生效）。
 */
export async function GET(request: NextRequest) {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const account = findAccount(auth.scope.accountId);
  if (!account) {
    return NextResponse.json({ error: "账号不存在或已被删除" }, { status: 401 });
  }

  return NextResponse.json({
    user: toSafeAccount(account),
    role: auth.scope.role,
  });
}
