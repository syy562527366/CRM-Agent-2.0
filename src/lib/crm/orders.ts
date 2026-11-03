import type { Order } from "@/types/order";
import { readLeads } from "./leads";
import { findProduct } from "./products";
import { nextId, nowStamp, readJson, writeJson } from "./store";

const FILE = "orders.json";

export interface OrderFilter {
  startDate?: string;
  endDate?: string;
  orderNo?: string;
  customerName?: string;
  customerPhone?: string;
  productName?: string;
}

export function readOrders(): Order[] {
  return readJson<Order>(FILE);
}

export function writeOrders(orders: Order[]): void {
  writeJson(FILE, orders);
}

export function findOrder(id: string): Order | undefined {
  return readOrders().find((order) => order.id === id);
}

export function searchOrders(filter: OrderFilter = {}): Order[] {
  const dayOf = (value?: string) => (value ? value.split(" ")[0] : "");
  return readOrders().filter((order) => {
    if (filter.startDate && dayOf(order.createdAt) < filter.startDate) return false;
    if (filter.endDate && dayOf(order.createdAt) > filter.endDate) return false;
    if (filter.orderNo && !order.orderNo.includes(filter.orderNo.trim())) return false;
    if (filter.customerName && !order.customerName.includes(filter.customerName.trim())) return false;
    if (filter.customerPhone && !order.customerPhone.includes(filter.customerPhone.trim())) return false;
    if (filter.productName && !order.productName.includes(filter.productName.trim())) return false;
    return true;
  });
}

/** 订单金额合计，供统计场景使用 */
export function sumOrderAmount(orders: Order[]): number {
  return orders.reduce((total, order) => total + Number(order.amount || 0), 0);
}

export function createOrder(input: { customerPhone: string; productId: string }):
  | { ok: true; order: Order }
  | { ok: false; error: string } {
  const phone = input.customerPhone.trim();
  const lead = readLeads().find((item) => item.phone === phone);
  if (!lead) return { ok: false, error: "未找到该客户信息" };

  const product = findProduct(input.productId);
  if (!product) return { ok: false, error: "未找到该商品信息" };

  const orders = readOrders();
  const order: Order = {
    id: nextId(orders, "OD-2026-"),
    createdAt: nowStamp(),
    orderNo: generateOrderNo(),
    customerName: lead.name,
    customerPhone: lead.phone,
    productId: product.id,
    productNo: product.productNo,
    productName: product.name,
    amount: product.price,
  };
  orders.unshift(order);
  writeOrders(orders);
  return { ok: true, order };
}

export function updateOrder(id: string, updates: Partial<Order>): Order | null {
  const orders = readOrders();
  const index = orders.findIndex((order) => order.id === id);
  if (index === -1) return null;

  const next: Partial<Order> = { ...updates };

  // 改客户电话时同步客户姓名；改商品时同步商品快照字段
  if (next.customerPhone) {
    const lead = readLeads().find((item) => item.phone === next.customerPhone);
    if (lead) next.customerName = lead.name;
  }
  if (next.productId) {
    const product = findProduct(next.productId);
    if (product) {
      next.productNo = product.productNo;
      next.productName = product.name;
      next.amount = product.price;
    }
  }

  orders[index] = { ...orders[index], ...next, id };
  writeOrders(orders);
  return orders[index];
}

export function deleteOrder(id: string): boolean {
  const orders = readOrders();
  const index = orders.findIndex((order) => order.id === id);
  if (index === -1) return false;
  orders.splice(index, 1);
  writeOrders(orders);
  return true;
}

function generateOrderNo(): string {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const rand = String(Math.floor(Math.random() * 900) + 100);
  return `ORD-${dateStr}${rand}`;
}
