import type { Product, ProductStatus } from "@/types/product";
import { nextId, nowStamp, readJson, writeJson } from "./store";

const FILE = "products.json";

export interface ProductFilter {
  startDate?: string;
  endDate?: string;
  productNo?: string;
  name?: string;
  category?: string;
  status?: ProductStatus;
}

export function readProducts(): Product[] {
  return readJson<Product>(FILE);
}

export function writeProducts(products: Product[]): void {
  writeJson(FILE, products);
}

export function findProduct(id: string): Product | undefined {
  return readProducts().find((product) => product.id === id);
}

export function searchProducts(filter: ProductFilter = {}): Product[] {
  const dayOf = (value?: string) => (value ? value.split(" ")[0] : "");
  return readProducts().filter((product) => {
    if (filter.startDate && dayOf(product.createdAt) < filter.startDate) return false;
    if (filter.endDate && dayOf(product.createdAt) > filter.endDate) return false;
    if (filter.productNo) {
      const kw = filter.productNo.trim();
      if (!product.productNo.includes(kw) && !product.id.includes(kw)) return false;
    }
    if (filter.name && !product.name.includes(filter.name.trim())) return false;
    if (filter.category && product.category !== filter.category) return false;
    // 没写 status 的老数据按「上架」算，避免导入前的商品被莫名归为下架
    if (filter.status && (product.status ?? "上架") !== filter.status) return false;
    return true;
  });
}

export function createProduct(input: {
  productNo: string;
  name: string;
  price: number;
  category?: string;
  unit?: string;
}): Product {
  const products = readProducts();
  const product: Product = {
    id: nextId(products, "PD-2026-"),
    createdAt: nowStamp(),
    productNo: input.productNo.trim(),
    name: input.name.trim(),
    price: input.price,
    status: "上架",
  };
  if (input.category) product.category = input.category.trim();
  if (input.unit) product.unit = input.unit.trim();
  products.unshift(product);
  writeProducts(products);
  return product;
}

export function updateProduct(id: string, updates: Partial<Product>): Product | null {
  const products = readProducts();
  const index = products.findIndex((product) => product.id === id);
  if (index === -1) return null;
  products[index] = { ...products[index], ...updates, id };
  writeProducts(products);
  return products[index];
}

export function deleteProduct(id: string): boolean {
  const products = readProducts();
  const index = products.findIndex((product) => product.id === id);
  if (index === -1) return false;
  products.splice(index, 1);
  writeProducts(products);
  return true;
}
