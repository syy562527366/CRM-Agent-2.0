import { NextRequest, NextResponse } from "next/server";
import type { CreateLeadRequest, Priority } from "@/types/lead";
import { authorize } from "@/lib/auth/session";
import { createLead, searchLeads } from "@/lib/crm/leads";
import { leadScopeFilter } from "@/lib/crm/scope";
import { paginate } from "@/lib/crm/store";

/**
 * GET /api/leads - 获取线索列表（支持筛选）
 *
 * 查询参数：
 *   startDate - 开始日期 (YYYY-MM-DD)
 *   endDate   - 结束日期 (YYYY-MM-DD)
 *   name      - 姓名模糊搜索
 *   phone     - 电话模糊搜索
 *   source    - 客户来源
 *   priority  - 优先级筛选 (high / medium / low)
 *   status    - 状态精确筛选，多个用英文逗号分隔（"成交,客户流失"）
 *   assignee  - 负责人精确筛选（数据范围「仅自己」时会被强制覆盖）
 *   keyword   - 编号 / 姓名 / 手机号模糊搜索
 *   page      - 页码（默认 1）
 *   pageSize  - 每页条数（默认 5）
 */
export async function GET(request: NextRequest) {
  const auth = authorize(request, "leads", "查看");
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);

  // 状态走精确匹配：状态里同时存在「长期未跟进」和「待跟进」，
  // 用 includes 会互相误命中，所以由调用方传完整状态名（可多选）。
  const status = (searchParams.get("status") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const scopeFilter = leadScopeFilter(auth.scope);

  const rows = searchLeads({
    // 数据范围「仅自己」时在此强制注入 assignee，调用方无法覆盖
    ...scopeFilter,
    // 有数据范围限制时不允许再换负责人，否则等于绕开「仅自己」
    assignee: scopeFilter.assignee ?? (searchParams.get("assignee") ?? undefined),
    status: status.length ? status : undefined,
    keyword: searchParams.get("keyword") ?? undefined,
    dateFrom: searchParams.get("startDate") ?? undefined,
    dateTo: searchParams.get("endDate") ?? undefined,
    name: searchParams.get("name") ?? undefined,
    phone: searchParams.get("phone") ?? undefined,
    source: searchParams.get("source") ?? undefined,
    priority: (searchParams.get("priority") as Priority) || "",
  });

  const page = Number(searchParams.get("page") ?? 1);
  const pageSize = Number(searchParams.get("pageSize") ?? 5);
  const paged = paginate(rows, page, pageSize);

  return NextResponse.json({
    data: paged.rows,
    total: paged.total,
    page: paged.page,
    pageSize: paged.pageSize,
  });
}

/**
 * POST /api/leads - 新增线索
 */
export async function POST(request: NextRequest) {
  const auth = authorize(request, "leads", "增加");
  if (!auth.ok) return auth.response;

  try {
    const body: CreateLeadRequest = await request.json();

    if (!body.name || !body.phone || !body.priority || !body.source || !body.assignee) {
      return NextResponse.json({ error: "请填写完整线索信息" }, { status: 400 });
    }

    const lead = createLead({
      name: body.name,
      phone: body.phone,
      priority: body.priority,
      source: body.source,
      assignee: body.assignee,
    });

    return NextResponse.json(lead, { status: 201 });
  } catch {
    return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
  }
}
