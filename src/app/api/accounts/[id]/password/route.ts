import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/session";
import { findAccount, updateAccount } from "@/lib/crm/accounts";
import { can } from "@/lib/crm/scope";

type Params = Promise<{ id: string }>;

/**
 * PUT /api/accounts/[id]/password - 修改密码
 *
 * 只能改自己的密码；管理员额外需要「账号 · 修改」权限才能改他人密码。
 * 不允许通过角色权限绕过「原密码校验」——改他人密码同样要提供对方原密码。
 */
export async function PUT(request: NextRequest, { params }: { params: Params }) {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;

  const isSelf = id === auth.scope.accountId;
  if (!isSelf && !can(auth.scope, "accounts", "修改")) {
    return NextResponse.json({ error: "只能修改自己的密码" }, { status: 403 });
  }

  try {
    const { oldPassword, newPassword } = await request.json();

    if (!oldPassword || !newPassword) {
      return NextResponse.json({ error: "请填写完整的密码信息" }, { status: 400 });
    }

    if (String(newPassword).length < 6) {
      return NextResponse.json({ error: "新密码长度不能少于6位" }, { status: 400 });
    }

    const account = findAccount(id);
    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    if (account.password !== oldPassword) {
      return NextResponse.json({ error: "原密码错误" }, { status: 400 });
    }

    const updated = updateAccount(id, { password: newPassword });
    if (!updated) {
      return NextResponse.json({ error: "修改失败" }, { status: 500 });
    }

    return NextResponse.json({ message: "密码修改成功" });
  } catch {
    return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
  }
}
