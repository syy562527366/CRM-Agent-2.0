import { NextRequest, NextResponse } from "next/server";
import type { CommunicationQuery } from "@/types/communication";
import { authorize } from "@/lib/auth/session";
import { searchCommunications } from "@/lib/crm/communications";
import { leadIdsOfAssignee } from "@/lib/crm/leads";
import { isOwnOnly } from "@/lib/crm/scope";
import { paginate } from "@/lib/crm/store";

/**
 * GET /api/communications - 获取沟通记录列表（支持筛选）
 *
 * 查询参数：
 *   leadId     - 按线索 ID 筛选
 *   senderRole - 发送人角色 (销售 / 客户)
 *   channel    - 沟通渠道
 *   startDate  - 开始日期 (YYYY-MM-DD)
 *   endDate    - 结束日期 (YYYY-MM-DD)
 *   page       - 页码（默认 1）
 *   pageSize   - 每页条数（默认 10）
 */
export async function GET(request: NextRequest) {
  const auth = authorize(request, "communications", "查看");
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);

  // 数据范围「仅自己」时，只返回本人负责线索下的沟通记录
  const ownLeadIds = isOwnOnly(auth.scope, "communications") || isOwnOnly(auth.scope, "leads")
    ? leadIdsOfAssignee(auth.scope.name)
    : undefined;

  const rows = searchCommunications({
    leadId: searchParams.get("leadId") ?? undefined,
    leadIds: ownLeadIds,
    senderRole: (searchParams.get("senderRole") as CommunicationQuery["senderRole"]) ?? "",
    channel: searchParams.get("channel") ?? undefined,
    startDate: searchParams.get("startDate") ?? undefined,
    endDate: searchParams.get("endDate") ?? undefined,
  });

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
