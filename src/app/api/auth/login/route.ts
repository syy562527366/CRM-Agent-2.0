import { NextRequest, NextResponse } from "next/server";
import { createToken, withSession } from "@/lib/auth/session";
import { findAccountByPhone, toSafeAccount } from "@/lib/crm/accounts";
import { findRole } from "@/lib/crm/roles";

/**
 * POST /api/auth/login - 登录
 *
 * 成功时返回 token（兼容前端已有的存储逻辑），同时写入 HttpOnly 会话 Cookie；
 * 后续请求由浏览器自动携带 Cookie，因此各页面无需改造 fetch。
 */
export async function POST(request: NextRequest) {
  try {
    const { phone, password } = await request.json();

    if (!phone || !password) {
      return NextResponse.json({ error: "请输入手机号和密码" }, { status: 400 });
    }

    const account = findAccountByPhone(phone);
    if (!account || account.password !== password) {
      return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
    }

    const role = findRole(account.roleId) ?? null;
    const token = createToken(account.id, account.roleId);

    return withSession(
      NextResponse.json({ user: toSafeAccount(account), role, token }),
      token
    );
  } catch {
    return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
  }
}
