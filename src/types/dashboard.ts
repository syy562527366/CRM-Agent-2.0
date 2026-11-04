/** 仪表盘概览：与 GET /api/stats?domain=overview 的返回结构一一对应 */

export interface DashboardKpi {
  /** 本期（本月 1 日至今天） */
  value: number;
  /** 上个同期（上月 1 日至上月同日）；为 0 时前端不显示百分比 */
  prev: number;
}

export interface StatGroup {
  key: string;
  count: number;
}

export interface DashboardOverview {
  today: string;
  month: string;
  dataScope: "全部" | "仅自己";
  kpi: {
    salesAmount: DashboardKpi;
    leadCount: DashboardKpi;
    orderCount: DashboardKpi;
    avgAmount: DashboardKpi;
    conversionRate: number;
    deals: number;
    leadsTotal: number;
  };
  trend: { date: string; amount: number; leads: number; orders: number }[];
  sources: StatGroup[];
  statusMix: StatGroup[];
  funnel: { label: string; value: number }[];
  products: { label: string; amount: number; count: number }[];
  ranking: { name: string; sales: number; deals: number; leads: number; rate: number }[];
}
