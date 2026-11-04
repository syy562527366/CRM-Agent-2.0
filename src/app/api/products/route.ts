import { NextRequest, NextResponse } from "next/server";
import type { CreateProductRequest } from "@/types/product";
import { authorize } from "@/lib/auth/session";
import { createProduct, searchProducts } from "@/lib/crm/products";
import { paginate } from "@/lib/crm/store";

/**
 * GET /api/products - 获取商品列表（支持筛选）
 *
 * 查询参数：
 *   startDate  - 开始日期 (YYYY-MM-DD)
 *   endDate    - 结束日期 (YYYY-MM-DD)
 *   productNo  - 商品编号模糊搜索
 *   name       - 商品名称模糊搜索
 *   category   - 类别精确筛选（CBAM 合规 / 碳核算核查 / …）
 *   status     - 上架 / 下架，不传表示全部
 *   page       - 页码（默认 1）
 *   pageSize   - 每页条数（默认 5）
 */
export async function GET(request: NextRequest) {
  const auth = authorize(request, "products", "查看");
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");

  const rows = searchProducts({
    startDate: searchParams.get("startDate") ?? undefined,
    endDate: searchParams.get("endDate") ?? undefined,
    productNo: searchParams.get("productNo") ?? undefined,
    name: searchParams.get("name") ?? undefined,
    category: searchParams.get("category") ?? undefined,
    status: status === "上架" || status === "下架" ? status : undefined,
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
 * POST /api/products - 新增商品
 */
export async function POST(request: NextRequest) {
  const auth = authorize(request, "products", "增加");
  if (!auth.ok) return auth.response;

  try {
    const body: CreateProductRequest = await request.json();

    if (!body.productNo || !body.name || body.price == null) {
      return NextResponse.json({ error: "请填写完整商品信息" }, { status: 400 });
    }

    const product = createProduct({
      productNo: body.productNo,
      name: body.name,
      price: body.price,
      category: body.category,
      unit: body.unit,
    });

    return NextResponse.json(product, { status: 201 });
  } catch {
    return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
  }
}
