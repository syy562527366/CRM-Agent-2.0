import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/auth/session";
import { deleteOrder, findOrder, updateOrder } from "@/lib/crm/orders";

type Params = Promise<{ id: string }>;

/**
 * GET /api/orders/[id] - 获取单个订单详情
 */
export async function GET(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "orders", "查看");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const order = findOrder(id);
  if (!order) {
    return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  }
  return NextResponse.json(order);
}

/**
 * PUT /api/orders/[id] - 修改订单
 */
export async function PUT(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "orders", "修改");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const body = await request.json();
    const updated = updateOrder(id, body);
    if (!updated) {
      return NextResponse.json({ error: "订单不存在" }, { status: 404 });
    }
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
  }
}

/**
 * DELETE /api/orders/[id] - 删除订单
 */
export async function DELETE(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "orders", "删除");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!deleteOrder(id)) {
    return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  }
  return NextResponse.json({ message: "删除成功" });
}
