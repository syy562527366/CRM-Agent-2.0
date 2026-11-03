import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/auth/session";
import { deleteAccount, findAccount, toSafeAccount, updateAccount } from "@/lib/crm/accounts";

type Params = Promise<{ id: string }>;

/**
 * GET /api/accounts/[id] - 获取单个账号详情
 */
export async function GET(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "accounts", "查看");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const account = findAccount(id);
  if (!account) {
    return NextResponse.json({ error: "账号不存在" }, { status: 404 });
  }
  return NextResponse.json(toSafeAccount(account));
}

/**
 * PUT /api/accounts/[id] - 修改账号
 */
export async function PUT(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "accounts", "修改");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const body = await request.json();
    const updated = updateAccount(id, body);
    if (!updated) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }
    return NextResponse.json(toSafeAccount(updated));
  } catch {
    return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
  }
}

/**
 * DELETE /api/accounts/[id] - 删除账号
 */
export async function DELETE(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "accounts", "删除");
  if (!auth.ok) return auth.response;

  const { id } = await params;

  // 不能删除自己，避免把自己踢下线
  if (id === auth.scope.accountId) {
    return NextResponse.json({ error: "不能删除当前登录账号" }, { status: 400 });
  }

  if (!deleteAccount(id)) {
    return NextResponse.json({ error: "账号不存在" }, { status: 404 });
  }
  return NextResponse.json({ message: "删除成功" });
}
