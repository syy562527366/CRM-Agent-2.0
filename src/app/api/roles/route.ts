import { NextRequest, NextResponse } from "next/server";
import type { CreateRoleRequest } from "@/types/role";
import { authorize } from "@/lib/auth/session";
import { createRole, readRoles } from "@/lib/crm/roles";
import { paginate } from "@/lib/crm/store";

/**
 * GET /api/roles - 获取角色列表（支持筛选）
 *
 * 查询参数：
 *   name     - 角色名模糊搜索
 *   page     - 页码（默认 1）
 *   pageSize - 每页条数（默认 10）
 */
export async function GET(request: NextRequest) {
  const auth = authorize(request, "roles", "查看");
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);

  const keyword = (searchParams.get("name") ?? "").trim();
  const rows = keyword ? readRoles().filter((role) => role.name.includes(keyword)) : readRoles();

  const paged = paginate(
    rows,
    Number(searchParams.get("page") ?? 1),
    Number(searchParams.get("pageSize") ?? 10)
  );

  return NextResponse.json({
    data: paged.rows,
    total: paged.total,
    page: paged.page,
    pageSize: paged.pageSize,
  });
}

/**
 * POST /api/roles - 新增角色
 */
export async function POST(request: NextRequest) {
  const auth = authorize(request, "roles", "增加");
  if (!auth.ok) return auth.response;

  try {
    const body: CreateRoleRequest = await request.json();

    if (!body.name) {
      return NextResponse.json({ error: "请输入角色名称" }, { status: 400 });
    }

    return NextResponse.json(createRole(body.name), { status: 201 });
  } catch {
    return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
  }
}
