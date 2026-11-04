import { NextRequest, NextResponse } from "next/server";
import type { CreateOrderRequest, OrderFormOptions } from "@/types/order";
import { authorize } from "@/lib/auth/session";
import { readLeads } from "@/lib/crm/leads";
import { createOrder, searchOrders } from "@/lib/crm/orders";
import { readProducts } from "@/lib/crm/products";
import { paginate } from "@/lib/crm/store";

/**
 * GET /api/orders - 获取订单列表（支持筛选）
 *
 * 查询参数：
 *   startDate    - 开始日期 (YYYY-MM-DD)
 *   endDate      - 结束日期 (YYYY-MM-DD)
 *   orderNo      - 订单编号模糊搜索
 *   customerName - 客户名称模糊搜索
 *   customerPhone- 客户电话模糊搜索
 *   productName  - 商品名称模糊搜索
 *   options      - 为 true 时返回新增表单所需的下拉选项
 *   page         - 页码（默认 1）
 *   pageSize     - 每页条数（默认 5）
 */
export async function GET(request: NextRequest) {
  const auth = authorize(request, "orders", "查看");
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);

  if (searchParams.get("options") === "true") {
    const options: OrderFormOptions = {
      leads: readLeads().map((lead) => ({ id: lead.id, name: lead.name, phone: lead.phone })),
      // 只给上架商品：下架的不该出现在新订单里。
      // 历史订单可能还指着已下架商品，那种情况由订单页自己补一个「已下架」选项。
      products: readProducts()
        .filter((product) => (product.status ?? "上架") === "上架")
        .map((product) => ({
          id: product.id,
          productNo: product.productNo,
          name: product.name,
          price: product.price,
        })),
    };
    return NextResponse.json(options);
  }

  const rows = searchOrders({
    startDate: searchParams.get("startDate") ?? undefined,
    endDate: searchParams.get("endDate") ?? undefined,
    orderNo: searchParams.get("orderNo") ?? undefined,
    customerName: searchParams.get("customerName") ?? undefined,
    customerPhone: searchParams.get("customerPhone") ?? undefined,
    productName: searchParams.get("productName") ?? undefined,
  });

  const paged = paginate(rows, Number(searchParams.get("page") ?? 1), Number(searchParams.get("pageSize") ?? 5));

  return NextResponse.json({
    data: paged.rows,
    total: paged.total,
    page: paged.page,
    pageSize: paged.pageSize,
  });
}

/**
 * POST /api/orders - 新增订单
 */
export async function POST(request: NextRequest) {
  const auth = authorize(request, "orders", "增加");
  if (!auth.ok) return auth.response;

  try {
    const body: CreateOrderRequest = await request.json();

    if (!body.customerPhone || !body.productId) {
      return NextResponse.json({ error: "请选择客户和商品" }, { status: 400 });
    }

    const result = createOrder({ customerPhone: body.customerPhone, productId: body.productId });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json(result.order, { status: 201 });
  } catch {
    return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
  }
}
