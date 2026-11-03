import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/auth/session";
import { deleteLead, findLead, updateLead } from "@/lib/crm/leads";
import { isOwnOnly, type CrmScope } from "@/lib/crm/scope";

type Params = Promise<{ id: string }>;

/** 数据范围校验：仅自己时，非本人负责的线索一律视为不存在 */
function visible(scope: CrmScope, assignee: string | undefined): boolean {
  if (!isOwnOnly(scope, "leads")) return true;
  return assignee === scope.name;
}

/**
 * GET /api/leads/[id] - 获取单个线索详情
 */
export async function GET(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "leads", "查看");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const lead = findLead(id);
  if (!lead || !visible(auth.scope, lead.assignee)) {
    return NextResponse.json({ error: "线索不存在" }, { status: 404 });
  }
  return NextResponse.json(lead);
}

/**
 * PUT /api/leads/[id] - 修改线索
 */
export async function PUT(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "leads", "修改");
  if (!auth.ok) return auth.response;

  const { id } = await params;

  const existing = findLead(id);
  if (!existing || !visible(auth.scope, existing.assignee)) {
    return NextResponse.json({ error: "线索不存在" }, { status: 404 });
  }

  try {
    const body = await request.json();
    const updated = updateLead(id, body);
    if (!updated) {
      return NextResponse.json({ error: "线索不存在" }, { status: 404 });
    }
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
  }
}

/**
 * DELETE /api/leads/[id] - 删除线索
 */
export async function DELETE(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "leads", "删除");
  if (!auth.ok) return auth.response;

  const { id } = await params;

  const existing = findLead(id);
  if (!existing || !visible(auth.scope, existing.assignee)) {
    return NextResponse.json({ error: "线索不存在" }, { status: 404 });
  }

  if (!deleteLead(id)) {
    return NextResponse.json({ error: "线索不存在" }, { status: 404 });
  }
  return NextResponse.json({ message: "删除成功" });
}
