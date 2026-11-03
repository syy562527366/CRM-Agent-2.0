import type { Lead } from "@/types/lead";
import type { Order } from "@/types/order";
import { readLeads, searchLeads } from "./leads";
import { searchOrders } from "./orders";
import { isOwnOnly, leadScopeFilter, type CrmScope } from "./scope";

/**
 * 统计聚合。刻意放在服务端算，而不是把全量明细拉给调用方（尤其是 Agent）再算：
 * - 35 条线索时无所谓，1000 条时就是几十万 token；
 * - 数字由服务端产出，模型无从「心算」出错。
 */

export type LeadGroupBy = "status" | "source" | "assignee" | "priority";
export type SalesGroupBy = "product" | "assignee" | "month";

export const LEAD_GROUP_BY: LeadGroupBy[] = ["status", "source", "assignee", "priority"];
export const SALES_GROUP_BY: SalesGroupBy[] = ["product", "assignee", "month"];

export interface StatGroup {
  /** 分组键（状态名 / 来源 / 负责人 / 商品名 / 月份） */
  key: string;
  /** 分组内的记录数 */
  count: number;
  /** 金额合计，仅销售统计有 */
  amount?: number;
  /** 客单价，仅销售统计有 */
  avgAmount?: number;
}

export interface StatResult {
  domain: "leads" | "sales";
  groupBy: string;
  /** 参与统计的总条数（已应用数据范围） */
  total: number;
  /** 金额总计，仅销售统计有 */
  amount?: number;
  groups: StatGroup[];
  /** 本次统计实际生效的数据范围，便于前端/模型如实说明 */
  dataScope: "全部" | "仅自己";
}

export interface StatFilter {
  dateFrom?: string;
  dateTo?: string;
}

/** 线索分组计数（状态漏斗、来源分布、负责人负载、优先级分布） */
export function leadStats(scope: CrmScope, groupBy: LeadGroupBy, filter: StatFilter = {}): StatResult {
  const rows = searchLeads({
    // 「仅自己」在此强制生效，调用方无法覆盖
    ...leadScopeFilter(scope),
    dateFrom: filter.dateFrom,
    dateTo: filter.dateTo,
  });

  const buckets = new Map<string, number>();
  for (const row of rows) {
    const key = String(row[groupBy] ?? "") || "未填写";
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  return {
    domain: "leads",
    groupBy,
    total: rows.length,
    groups: rank(buckets),
    dataScope: isOwnOnly(scope, "leads") ? "仅自己" : "全部",
  };
}

/**
 * 销售统计：成交额 / 订单数 / 客单价。
 *
 * 订单本身没有负责人字段，「仅自己」时按「本人负责线索的手机号」过滤订单，
 * 与线索页的数据范围口径保持一致。
 */
export function salesStats(
  scope: CrmScope,
  groupBy: SalesGroupBy,
  filter: StatFilter = {},
): StatResult {
  const leads = readLeads();
  const ownOnly = isOwnOnly(scope, "orders") || isOwnOnly(scope, "leads");

  const rows = searchOrders({
    startDate: filter.dateFrom,
    endDate: filter.dateTo,
  }).filter((order) => {
    if (!ownOnly) return true;
    const owner = leads.find((lead) => lead.phone === order.customerPhone);
    return owner?.assignee === scope.name;
  });

  const buckets = new Map<string, { count: number; amount: number }>();
  for (const order of rows) {
    const key = groupKeyOf(order, groupBy, leads);
    const bucket = buckets.get(key) ?? { count: 0, amount: 0 };
    bucket.count += 1;
    bucket.amount += Number(order.amount || 0);
    buckets.set(key, bucket);
  }

  const total = rows.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  const groups = [...buckets.entries()]
    .sort((a, b) => b[1].amount - a[1].amount)
    .map(([key, bucket]) => ({
      key,
      count: bucket.count,
      amount: round2(bucket.amount),
      avgAmount: bucket.count ? round2(bucket.amount / bucket.count) : 0,
    }));

  return {
    domain: "sales",
    groupBy,
    total: rows.length,
    amount: round2(total),
    groups,
    dataScope: ownOnly ? "仅自己" : "全部",
  };
}

function groupKeyOf(order: Order, groupBy: SalesGroupBy, leads: Lead[]): string {
  if (groupBy === "product") return order.productName || "未知商品";
  if (groupBy === "month") return String(order.createdAt ?? "").slice(0, 7) || "未知月份";
  const owner = leads.find((lead) => lead.phone === order.customerPhone);
  return owner?.assignee || "未归属";
}

/** 计数从多到少排序，同数量按名称稳定排序 */
function rank(buckets: Map<string, number>): StatGroup[] {
  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .map(([key, count]) => ({ key, count }));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
