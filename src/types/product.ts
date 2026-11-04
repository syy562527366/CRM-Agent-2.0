/** 商品类别（按合同里实际成交的服务类型归并） */
export const PRODUCT_CATEGORIES = [
  "CBAM 合规",
  "碳核算核查",
  "碳资产交易",
  "数字化系统",
  "咨询评价",
  "培训",
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/** 上架状态。下架商品不进新增订单的可选列表，但历史订单仍能正常显示。 */
export type ProductStatus = "上架" | "下架";

/** 商品数据 */
export interface Product {
  id: string;
  createdAt: string;
  /** 商务口径的产品编号（合同里用的编码，如 TQC-01） */
  productNo: string;
  name: string;
  /** 参考价：历史成交价的中位数，0 表示待定价 */
  price: number;
  category?: string;
  unit?: string;
  status?: ProductStatus;
  /** 以下为合同成交统计，导入时按明细行聚合 */
  dealCount?: number;
  totalQty?: number;
  priceMin?: number;
  priceMax?: number;
  firstDealAt?: string;
  lastDealAt?: string;
  /** 数据来源说明（如「历史合同未填产品编号，系统补号」） */
  note?: string;
}

/** 新增商品请求体 */
export interface CreateProductRequest {
  productNo: string;
  name: string;
  price: number;
  category?: string;
  unit?: string;
}

/** 商品列表查询参数 */
export interface ProductQuery {
  startDate?: string;
  endDate?: string;
  productNo?: string;
  name?: string;
  category?: string;
  status?: ProductStatus;
}

/** 商品列表 API 响应 */
export interface ProductListResponse {
  data: Product[];
  total: number;
  page: number;
  pageSize: number;
}
