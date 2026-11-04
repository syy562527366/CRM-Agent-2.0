import type { Lead } from "@/types/lead";
import type { Order } from "@/types/order";
import { localToday } from "@/lib/date";
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

/* ==================== 仪表盘概览 ==================== */

/** 一个指标：本期值 + 上一个同期值（供前端算环比） */
export interface DashboardKpi {
  value: number;
  prev: number;
}

export interface DashboardOverview {
  /** 统计截止日（YYYY-MM-DD），前端用于展示「截至 X 月 X 日」 */
  today: string;
  /** 本月（YYYY-MM） */
  month: string;
  dataScope: "全部" | "仅自己";
  kpi: {
    /** 本月成交额（订单金额合计） */
    salesAmount: DashboardKpi;
    /** 本月新增线索数 */
    leadCount: DashboardKpi;
    /** 本月订单数 */
    orderCount: DashboardKpi;
    /** 本月客单价 */
    avgAmount: DashboardKpi;
    /** 线索转化率（%），全量口径 */
    conversionRate: number;
    /** 成交线索数 / 线索总数 */
    deals: number;
    leadsTotal: number;
  };
  /** 近 30 天逐日趋势 */
  trend: { date: string; amount: number; leads: number; orders: number }[];
  /** 线索来源分布 */
  sources: StatGroup[];
  /** 线索状态分布 */
  statusMix: StatGroup[];
  /** 转化漏斗（逐级递减） */
  funnel: { label: string; value: number }[];
  /** 商品销售额 Top N */
  products: { label: string; amount: number; count: number }[];
  /** 销售人员业绩 */
  ranking: { name: string; sales: number; deals: number; leads: number; rate: number }[];
}

/** 成交漏斗里算作「已成交」的状态 */
const DEAL_STATUS = "成交";
/** 已推进到方案阶段的状态 */
const PROPOSAL_STATUSES = new Set(["推荐产品", "成交"]);
const PRODUCT_TOP_N = 6;
/** 趋势图天数。15 天在大单业务里经常只剩一两个点，30 天才能看出节奏 */
const TREND_DAYS = 30;

/**
 * 仪表盘一次性聚合。
 *
 * 一次算完而不是让前端连 5 个接口：图表之间必须口径一致（同一批线索、同一个「今天」），
 * 分开请求会出现「卡片 82 条线索、饼图 80 条来源」这种自相矛盾。
 *
 * 同比口径：本期为「本月 1 日至今天」，上一期为「上月 1 日至上月同日」，
 * 而不是整月对比 —— 月初跑整月对比必然暴跌，没有参考价值。
 */
export function dashboardOverview(scope: CrmScope, today = localToday()): DashboardOverview {
  const month = today.slice(0, 7);
  const prevMonth = shiftMonth(month, -1);
  const dayOfMonth = Number(today.slice(8, 10));
  const prevCutoff = `${prevMonth}-${String(dayOfMonth).padStart(2, "0")}`;

  const leads = searchLeads(leadScopeFilter(scope));
  const ownOnly = isOwnOnly(scope, "orders") || isOwnOnly(scope, "leads");
  const ownerOf = new Map(leads.map((lead) => [lead.phone, lead.assignee]));
  const orders = searchOrders().filter((order) => {
    if (!ownOnly) return true;
    return ownerOf.get(order.customerPhone) === scope.name;
  });

  const inRange = (stamp: string | undefined, from: string, to: string) => {
    const day = String(stamp ?? "").split(" ")[0];
    return day >= from && day <= to;
  };

  const monthOrders = orders.filter((o) => inRange(o.createdAt, `${month}-01`, today));
  const prevOrders = orders.filter((o) => inRange(o.createdAt, `${prevMonth}-01`, prevCutoff));
  const monthLeads = leads.filter((l) => inRange(l.createdAt, `${month}-01`, today));
  const prevLeads = leads.filter((l) => inRange(l.createdAt, `${prevMonth}-01`, prevCutoff));

  const deals = leads.filter((l) => l.status === DEAL_STATUS).length;

  // 近 30 天趋势：先按日期建桶再填，保证没有数据的日子也占位（否则折线会连起来骗人）
  const trend: DashboardOverview["trend"] = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const date = shiftDay(today, -i);
    const orderRows = orders.filter((o) => String(o.createdAt ?? "").startsWith(date));
    trend.push({
      date,
      amount: round2(orderRows.reduce((sum, o) => sum + Number(o.amount || 0), 0)),
      leads: leads.filter((l) => String(l.createdAt ?? "").startsWith(date)).length,
      orders: orderRows.length,
    });
  }

  const statusBuckets = new Map<string, number>();
  for (const lead of leads) {
    const key = lead.status || "未填写";
    statusBuckets.set(key, (statusBuckets.get(key) ?? 0) + 1);
  }

  const productBuckets = new Map<string, { amount: number; count: number }>();
  for (const order of orders) {
    const key = order.productName || "未知商品";
    const bucket = productBuckets.get(key) ?? { amount: 0, count: 0 };
    bucket.amount += Number(order.amount || 0);
    bucket.count += 1;
    productBuckets.set(key, bucket);
  }
  const productSorted = [...productBuckets.entries()].sort((a, b) => b[1].amount - a[1].amount);
  const products = productSorted.slice(0, PRODUCT_TOP_N).map(([label, b]) => ({
    label,
    amount: round2(b.amount),
    count: b.count,
  }));
  const rest = productSorted.slice(PRODUCT_TOP_N);
  if (rest.length) {
    products.push({
      label: `其他 ${rest.length} 项`,
      amount: round2(rest.reduce((sum, [, b]) => sum + b.amount, 0)),
      count: rest.reduce((sum, [, b]) => sum + b.count, 0),
    });
  }

  const ranking = rankSalespeople(leads, orders);

  return {
    today,
    month,
    dataScope: ownOnly ? "仅自己" : "全部",
    kpi: {
      salesAmount: {
        value: round2(monthOrders.reduce((sum, o) => sum + Number(o.amount || 0), 0)),
        prev: round2(prevOrders.reduce((sum, o) => sum + Number(o.amount || 0), 0)),
      },
      leadCount: { value: monthLeads.length, prev: prevLeads.length },
      orderCount: { value: monthOrders.length, prev: prevOrders.length },
      avgAmount: {
        value: monthOrders.length ? round2(sumAmount(monthOrders) / monthOrders.length) : 0,
        prev: prevOrders.length ? round2(sumAmount(prevOrders) / prevOrders.length) : 0,
      },
      conversionRate: leads.length ? round2((deals / leads.length) * 100) : 0,
      deals,
      leadsTotal: leads.length,
    },
    trend,
    sources: rank(mapCount(leads, (l) => l.source)),
    statusMix: rank(statusBuckets),
    funnel: [
      { label: "线索获取", value: leads.length },
      {
        label: "已建立联系",
        value: leads.filter((l) => l.status !== "未接触" && (l.communicationCount ?? 0) > 0).length,
      },
      { label: "已推荐方案", value: leads.filter((l) => PROPOSAL_STATUSES.has(l.status ?? "")).length },
      { label: DEAL_STATUS, value: deals },
    ],
    products,
    ranking,
  };
}

/** 按负责人聚合：成交额、订单数、线索数、转化率 */
function rankSalespeople(leads: Lead[], orders: Order[]): DashboardOverview["ranking"] {
  const buckets = new Map<string, { sales: number; deals: number; leads: number; won: number }>();

  for (const lead of leads) {
    const name = lead.assignee || "未归属";
    const bucket = buckets.get(name) ?? { sales: 0, deals: 0, leads: 0, won: 0 };
    bucket.leads += 1;
    if (lead.status === DEAL_STATUS) bucket.won += 1;
    buckets.set(name, bucket);
  }

  const ownerOf = new Map(leads.map((lead) => [lead.phone, lead.assignee || "未归属"]));
  for (const order of orders) {
    const name = ownerOf.get(order.customerPhone) ?? "未归属";
    const bucket = buckets.get(name) ?? { sales: 0, deals: 0, leads: 0, won: 0 };
    bucket.sales += Number(order.amount || 0);
    bucket.deals += 1;
    buckets.set(name, bucket);
  }

  return [...buckets.entries()]
    .map(([name, b]) => ({
      name,
      sales: round2(b.sales),
      deals: b.deals,
      leads: b.leads,
      rate: b.leads ? round2((b.won / b.leads) * 100) : 0,
    }))
    .sort((a, b) => b.sales - a.sales || b.deals - a.deals);
}

function mapCount<T>(rows: T[], keyOf: (row: T) => string | undefined): Map<string, number> {
  const buckets = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row) || "未填写";
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return buckets;
}

function sumAmount(orders: Order[]): number {
  return orders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
}

function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split("-").map(Number);
  const total = year * 12 + (mon - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() + delta);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
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
