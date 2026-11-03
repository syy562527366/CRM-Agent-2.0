import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/auth/session";
import { deleteProduct, findProduct, updateProduct } from "@/lib/crm/products";

type Params = Promise<{ id: string }>;

/**
 * GET /api/products/[id] - 获取单个商品详情
 */
export async function GET(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "products", "查看");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const product = findProduct(id);
  if (!product) {
    return NextResponse.json({ error: "商品不存在" }, { status: 404 });
  }
  return NextResponse.json(product);
}

/**
 * PUT /api/products/[id] - 修改商品
 */
export async function PUT(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "products", "修改");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const body = await request.json();
    const updated = updateProduct(id, body);
    if (!updated) {
      return NextResponse.json({ error: "商品不存在" }, { status: 404 });
    }
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
  }
}

/**
 * DELETE /api/products/[id] - 删除商品
 */
export async function DELETE(request: NextRequest, { params }: { params: Params }) {
  const auth = authorize(request, "products", "删除");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!deleteProduct(id)) {
    return NextResponse.json({ error: "商品不存在" }, { status: 404 });
  }
  return NextResponse.json({ message: "删除成功" });
}
