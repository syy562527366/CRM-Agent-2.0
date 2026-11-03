import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/auth/session";
import { deleteRole, findRole, updateRole } from "@/lib/crm/roles";

type Params = Promise<{ id: string }>;

/**
 * GET /api/roles/[id] - 获取单个角色详情
 */
export async function GET(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "roles", "查看");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const role = findRole(id);
  if (!role) {
    return NextResponse.json({ error: "角色不存在" }, { status: 404 });
  }
  return NextResponse.json(role);
}

/**
 * PUT /api/roles/[id] - 修改角色（名称 / 权限）
 */
export async function PUT(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "roles", "修改");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const body = await request.json();
    const updated = updateRole(id, body);
    if (!updated) {
      return NextResponse.json({ error: "角色不存在" }, { status: 404 });
    }
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
  }
}

/**
 * DELETE /api/roles/[id] - 删除角色
 */
export async function DELETE(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "roles", "删除");
  if (!auth.ok) return auth.response;

  const { id } = await params;

  // 不允许删除自己所属的角色，避免把自己锁死
  if (id === auth.scope.roleId) {
    return NextResponse.json({ error: "不能删除当前登录账号所属的角色" }, { status: 400 });
  }

  if (!deleteRole(id)) {
    return NextResponse.json({ error: "角色不存在" }, { status: 404 });
  }
  return NextResponse.json({ message: "删除成功" });
}
