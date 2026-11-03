import { NextRequest, NextResponse } from "next/server";
import type { CreateAccountRequest } from "@/types/account";
import { authorize } from "@/lib/auth/session";
import {
  createAccount,
  findAccountByPhone,
  searchAccounts,
  toSafeAccount,
} from "@/lib/crm/accounts";
import { findRole, readRoles } from "@/lib/crm/roles";
import { paginate } from "@/lib/crm/store";

/**
 * GET /api/accounts - 获取账号列表（支持筛选）
 *
 * 查询参数：
 *   roles     - 为 true 时返回角色下拉选项
 *   startDate - 开始日期 (YYYY-MM-DD)
 *   endDate   - 结束日期 (YYYY-MM-DD)
 *   phone     - 手机号模糊搜索
 *   name      - 用户姓名模糊搜索
 *   roleName  - 所属角色模糊搜索
 *   page      - 页码（默认 1）
 *   pageSize  - 每页条数（默认 10）
 */
export async function GET(request: NextRequest) {
  const auth = authorize(request, "accounts", "查看");
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);

  if (searchParams.get("roles") === "true") {
    return NextResponse.json(readRoles().map((role) => ({ id: role.id, name: role.name })));
  }

  const rows = searchAccounts({
    startDate: searchParams.get("startDate") ?? undefined,
    endDate: searchParams.get("endDate") ?? undefined,
    phone: searchParams.get("phone") ?? undefined,
    name: searchParams.get("name") ?? undefined,
    roleName: searchParams.get("roleName") ?? undefined,
  });

  const paged = paginate(
    rows,
    Number(searchParams.get("page") ?? 1),
    Number(searchParams.get("pageSize") ?? 10)
  );

  return NextResponse.json({
    data: paged.rows.map(toSafeAccount),
    total: paged.total,
    page: paged.page,
    pageSize: paged.pageSize,
  });
}

/**
 * POST /api/accounts - 新增账号
 */
export async function POST(request: NextRequest) {
  const auth = authorize(request, "accounts", "增加");
  if (!auth.ok) return auth.response;

  try {
    const body: CreateAccountRequest = await request.json();

    if (!body.phone || !body.name || !body.roleId) {
      return NextResponse.json({ error: "请填写完整的账号信息" }, { status: 400 });
    }

    if (findAccountByPhone(body.phone.trim())) {
      return NextResponse.json({ error: "该手机号已被注册" }, { status: 400 });
    }

    const role = findRole(body.roleId);
    if (!role) {
      return NextResponse.json({ error: "所选角色不存在" }, { status: 400 });
    }

    const account = createAccount({
      phone: body.phone,
      name: body.name,
      roleId: role.id,
      roleName: role.name,
    });

    return NextResponse.json(toSafeAccount(account), { status: 201 });
  } catch {
    return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
  }
}
