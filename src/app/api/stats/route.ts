import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/auth/session";
import {
  LEAD_GROUP_BY,
  SALES_GROUP_BY,
  leadStats,
  salesStats,
  type LeadGroupBy,
  type SalesGroupBy,
} from "@/lib/crm/stats";

/**
 * GET /api/stats - 聚合统计（供仪表盘与 Agent 工具共用）
 *
 * 查询参数：
 *   domain    - leads（线索）| sales（销售），默认 leads
 *   groupBy   - leads: status / source / assignee / priority
 *               sales: product / assignee / month
 *   startDate - 开始日期 (YYYY-MM-DD)
 *   endDate   - 结束日期 (YYYY-MM-DD)
 *
 * 数据范围「仅自己」在 service 层强制生效，调用方无法通过参数绕过。
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const domain = searchParams.get("domain") ?? "leads";
  const startDate = searchParams.get("startDate") ?? undefined;
  const endDate = searchParams.get("endDate") ?? undefined;

  if (domain === "leads") {
    const auth = authorize(request, "leads", "查看");
    if (!auth.ok) return auth.response;

    const groupBy = searchParams.get("groupBy") ?? "status";
    if (!LEAD_GROUP_BY.includes(groupBy as LeadGroupBy)) {
      return NextResponse.json(
        { error: `groupBy 仅支持 ${LEAD_GROUP_BY.join(" / ")}` },
        { status: 400 },
      );
    }

    return NextResponse.json(
      leadStats(auth.scope, groupBy as LeadGroupBy, { dateFrom: startDate, dateTo: endDate }),
    );
  }

  if (domain === "sales") {
    const auth = authorize(request, "orders", "查看");
    if (!auth.ok) return auth.response;

    const groupBy = searchParams.get("groupBy") ?? "product";
    if (!SALES_GROUP_BY.includes(groupBy as SalesGroupBy)) {
      return NextResponse.json(
        { error: `groupBy 仅支持 ${SALES_GROUP_BY.join(" / ")}` },
        { status: 400 },
      );
    }

    return NextResponse.json(
      salesStats(auth.scope, groupBy as SalesGroupBy, { dateFrom: startDate, dateTo: endDate }),
    );
  }

  return NextResponse.json({ error: "domain 仅支持 leads / sales" }, { status: 400 });
}
