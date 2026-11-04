"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import { Line, Bar, Pie } from "react-chartjs-2";
import Sidebar from "./Sidebar";
import type { DashboardKpi, DashboardOverview, StatGroup } from "@/types/dashboard";

// ---- 注册 Chart.js 组件 ----
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Title, Tooltip, Legend, Filler);

/* ========== 工具样式 ========== */
const CARD: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #E2E8F0",
  borderRadius: 12,
  padding: "20px 24px",
};

const STATUS_COLORS: Record<string, string> = {
  成交: "#059669",
  推荐产品: "#2563EB",
  长期未跟进: "#D97706",
  客户流失: "#DC2626",
  未接触: "#94A3B8",
};

/* ========== 数字格式化 ========== */
/** 金额：过万折成「万」，避免仪表盘上出现 1775000 这种一长串 */
function money(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10000) {
    const wan = value / 10000;
    // 只保留真正有意义的位数：177.5 万不要写成 178 万，1,150 万也不要写成 1150.0 万
    return `¥${Number(wan.toFixed(wan >= 1000 ? 0 : 1))}万`;
  }
  return `¥${value.toLocaleString("zh-CN")}`;
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/* ========== 环比 ========== */
function Delta({ kpi, format }: { kpi: DashboardKpi; format: (v: number) => string }) {
  if (kpi.prev <= 0) {
    // 上期一单没有时算不出增长率，硬写「↑100%」是骗人的
    return <span style={{ color: "#94A3B8" }}>{kpi.value > 0 ? "上月同期无数据" : "本月暂无"}</span>;
  }
  const pct = ((kpi.value - kpi.prev) / kpi.prev) * 100;
  const up = pct >= 0;
  return (
    <span style={{ color: up ? "#059669" : "#DC2626" }}>
      {up ? "↑" : "↓"} {Math.abs(pct).toFixed(1)}% · 上月 {format(kpi.prev)}
    </span>
  );
}

/* ========== Chart 全局默认配置 ========== */
const lineOptions = {
  responsive: true,
  maintainAspectRatio: false,
  // 首尾数据点默认会顶在绘图区边缘，留点白线才不会被裁掉
  layout: { padding: { top: 8, right: 10 } },
  plugins: { legend: { display: false } },
  scales: {
    x: {
      grid: { display: false },
      ticks: { color: "#94A3B8", fontSize: 10, maxRotation: 0, autoSkipPadding: 12, includeBounds: true },
    },
    y: { grid: { color: "#F1F5F9" }, ticks: { color: "#94A3B8", fontSize: 11 } },
  },
};

/* ========== 趋势图表选项卡 ========== */
function TrendCharts({ trend }: { trend: DashboardOverview["trend"] }) {
  const [tab, setTab] = useState<"sales" | "leads" | "orders">("sales");

  const tabs = [
    { key: "sales", label: "成交额" },
    { key: "leads", label: "客户线索数" },
    { key: "orders", label: "订单数" },
  ] as const;

  const labels = trend.map((row) => row.date.slice(5));
  const series = {
    sales: trend.map((row) => row.amount),
    leads: trend.map((row) => row.leads),
    orders: trend.map((row) => row.orders),
  };

  const palette = {
    sales: { color: "#2563EB", bg: "rgba(37, 99, 235, 0.08)", label: "成交额" },
    leads: { color: "#059669", bg: "rgba(5, 150, 105, 0.08)", label: "客户线索数" },
    orders: { color: "#D97706", bg: "rgba(217, 119, 6, 0.08)", label: "订单数" },
  }[tab];

  const chartData = {
    labels,
    datasets: [
      {
        label: palette.label,
        data: series[tab],
        borderColor: palette.color,
        backgroundColor: palette.bg,
        fill: true,
        tension: 0.3,
        pointBackgroundColor: palette.color,
        pointBorderColor: "#fff",
        pointBorderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
      },
    ],
  };

  const unitMap = { sales: "元", leads: "个", orders: "单" };

  return (
    <div style={CARD}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", margin: 0 }}>业绩趋势</h3>
        <div style={{ display: "flex", gap: 4, background: "#F1F5F9", borderRadius: 8, padding: 2 }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "inherit",
                background: tab === t.key ? "#fff" : "transparent",
                color: tab === t.key ? "#2563EB" : "#64748B",
                boxShadow: tab === t.key ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                transition: "all 0.15s",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ height: 260 }}>
        <Line data={chartData} options={lineOptions} />
      </div>
      <div style={{ textAlign: "center", fontSize: 11, color: "#94A3B8", marginTop: 8 }}>
        近 {trend.length} 天{palette.label}趋势（单位：{unitMap[tab]}）
      </div>
    </div>
  );
}

/* ========== 卡头样式 ========== */
function CardHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", margin: 0 }}>{title}</h3>
      {hint ? <span style={{ fontSize: 11, color: "#94A3B8" }}>{hint}</span> : null}
    </div>
  );
}

/* ========== 线索状态分布（堆叠条） ========== */
function StatusMixBar({ statusMix, total }: { statusMix: StatGroup[]; total: number }) {
  const rows = statusMix.filter((row) => row.count > 0);
  return (
    <div style={{ ...CARD, marginBottom: 20, padding: "14px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#1E293B", whiteSpace: "nowrap" }}>线索状态分布</span>
        <div style={{ flex: 1, minWidth: 240, height: 10, borderRadius: 10, overflow: "hidden", display: "flex", background: "#F1F5F9" }}>
          {rows.map((row) => (
            <div
              key={row.key}
              title={`${row.key}：${row.count} 条（${((row.count / total) * 100).toFixed(1)}%）`}
              style={{
                width: `${(row.count / total) * 100}%`,
                background: STATUS_COLORS[row.key] ?? "#CBD5E1",
                transition: "width 0.3s",
              }}
            />
          ))}
        </div>
        <span style={{ fontSize: 12, color: "#64748B", whiteSpace: "nowrap" }}>共 {total} 条线索</span>
      </div>
      <div style={{ display: "flex", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
        {rows.map((row) => (
          <span key={row.key} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748B" }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: STATUS_COLORS[row.key] ?? "#CBD5E1" }} />
            {row.key} {row.count}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ========== 漏斗图（自定义） ========== */
function FunnelChart({ funnel, leadsTotal }: { funnel: DashboardOverview["funnel"]; leadsTotal: number }) {
  const maxVal = Math.max(...funnel.map((d) => d.value), 1);
  const colors = ["#2563EB", "#3B82F6", "#60A5FA", "#93C5FD"];

  return (
    <div style={CARD}>
      <CardHeader title="客户转化漏斗" hint="按线索状态逐级收窄" />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {funnel.map((item, i) => {
          const pct = Math.round((item.value / maxVal) * 100);
          const rate = leadsTotal ? ((item.value / leadsTotal) * 100).toFixed(0) : "0";
          return (
            <div key={item.label}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: "#1E293B", fontWeight: 600 }}>{item.label}</span>
                <span style={{ color: "#64748B" }}>
                  {item.value} 条 · {rate}%
                </span>
              </div>
              <div
                style={{
                  height: 28,
                  width: `${pct}%`,
                  background: colors[i],
                  borderRadius: 6,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 600,
                  transition: "width 0.3s",
                  minWidth: 40,
                }}
              >
                {item.value} 条
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ========== 柱状图封装 ========== */
function BarChartWidget({ title, data, label, color }: { title: string; data: { label: string; value: number }[]; label: string; color: string }) {
  const chartData = {
    labels: data.map((d) => d.label),
    datasets: [
      {
        label,
        data: data.map((d) => d.value),
        backgroundColor: color,
        borderRadius: 4,
        barThickness: 22,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: "y" as const,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: "#F1F5F9" }, ticks: { color: "#94A3B8", fontSize: 11 } },
      y: { grid: { display: false }, ticks: { color: "#1E293B", fontSize: 11, font: { weight: 500 } } },
    },
  };

  return (
    <div style={CARD}>
      <CardHeader title={title} />
      <div style={{ height: data.length > 6 ? 300 : 220 }}>
        <Bar data={chartData} options={options} />
      </div>
    </div>
  );
}

/* ========== 饼图封装 ========== */
function PieChartWidget({ title, data }: { title: string; data: { label: string; value: number }[] }) {
  const colors = ["#2563EB", "#059669", "#D97706", "#DC2626", "#7C3AED", "#0891B2", "#F59E0B", "#94A3B8"];

  const chartData = {
    labels: data.map((d) => d.label),
    datasets: [
      {
        data: data.map((d) => d.value),
        backgroundColor: colors.slice(0, data.length),
        borderWidth: 2,
        borderColor: "#fff",
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: "right" as const,
        labels: { color: "#1E293B", fontSize: 11, padding: 10, usePointStyle: true, boxWidth: 8 },
      },
      tooltip: {
        callbacks: {
          label: (ctx: { label?: string; parsed: number }) =>
            ` ${ctx.label}：${money(ctx.parsed)}`,
        },
      },
    },
  };

  return (
    <div style={CARD}>
      <CardHeader title={title} hint="按成交额" />
      <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Pie data={chartData} options={options} />
      </div>
    </div>
  );
}

/* ========== 双条形排行榜 ========== */
function SalesRanking({ ranking }: { ranking: DashboardOverview["ranking"] }) {
  const [rankingTab, setRankingTab] = useState<"sales" | "rate">("sales");

  const displayData = [...ranking].sort((a, b) =>
    rankingTab === "sales" ? b.sales - a.sales : b.rate - a.rate,
  );
  const maxVal = Math.max(
    ...displayData.map((d) => (rankingTab === "sales" ? d.sales : d.rate)),
    1,
  );
  const rankColors = ["#F59E0B", "#94A3B8", "#CD7F32", "#2563EB", "#2563EB", "#3B82F6", "#60A5FA", "#7C3AED", "#8B5CF6", "#A78BFA"];

  const tabButton = (key: "sales" | "rate", label: string) => (
    <button
      onClick={() => setRankingTab(key)}
      style={{
        padding: "6px 14px",
        borderRadius: 6,
        border: "none",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 600,
        fontFamily: "inherit",
        background: rankingTab === key ? "#fff" : "transparent",
        color: rankingTab === key ? "#2563EB" : "#64748B",
        boxShadow: rankingTab === key ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={CARD}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: "#0F172A", margin: 0 }}>销售人员业绩排行榜</h3>
        <div style={{ display: "flex", gap: 4, background: "#F1F5F9", borderRadius: 8, padding: 2 }}>
          {tabButton("sales", "成交额")}
          {tabButton("rate", "转化率")}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {displayData.map((item, i) => {
          const current = rankingTab === "sales" ? item.sales : item.rate;
          const pct = Math.max(Math.round((current / maxVal) * 100), 2);
          return (
            <div key={item.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 20, fontSize: 12, fontWeight: 700, color: i < 3 ? rankColors[i] : "#94A3B8", textAlign: "center" }}>
                {i + 1}
              </span>
              <span style={{ width: 56, fontSize: 12, fontWeight: 600, color: "#1E293B", flexShrink: 0 }}>{item.name}</span>
              <div style={{ flex: 1, height: 24, background: "#F1F5F9", borderRadius: 6, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${pct}%`,
                    background: `linear-gradient(90deg, ${rankColors[i] ?? "#2563EB"}, ${rankColors[i] ?? "#2563EB"}88)`,
                    borderRadius: 6,
                    display: "flex",
                    alignItems: "center",
                    paddingLeft: 8,
                    transition: "width 0.3s",
                    minWidth: 56,
                  }}
                >
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#fff", whiteSpace: "nowrap" }}>
                    {rankingTab === "sales" ? money(current) : percent(current)}
                  </span>
                </div>
              </div>
              <span style={{ width: 96, fontSize: 11, color: "#94A3B8", textAlign: "right", flexShrink: 0 }}>
                {item.deals} 单 / {item.leads} 条线索
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ========== 骨架屏 ========== */
function Skeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ ...CARD, height: 92, background: "#F8FAFC" }} />
        ))}
      </div>
      <div style={{ ...CARD, height: 60, background: "#F8FAFC" }} />
      <div style={{ ...CARD, height: 340, background: "#F8FAFC" }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ ...CARD, height: 280, background: "#F8FAFC" }} />
        ))}
      </div>
    </div>
  );
}

/* ========== 主页面 ========== */
export default function Dashboard() {
  const [data, setData] = useState<DashboardOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stats?domain=overview", { cache: "no-store" });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error || `接口返回 ${res.status}`);
      }
      setData((await res.json()) as DashboardOverview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const kpi = data?.kpi;

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar activeItem="dashboard" />
      <main style={{ flex: 1, minWidth: 0, padding: "28px 32px", overflowY: "auto", height: "100vh" }}>
        {/* 页面标题 */}
        <div style={{ marginBottom: 24, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: "#0F172A", letterSpacing: "-0.02em", margin: 0 }}>数据仪表盘</h1>
            <p style={{ fontSize: 13, color: "#64748B", marginTop: 4, margin: 0 }}>
              查看业务核心指标和数据分析
            </p>
          </div>
          {data ? (
            <span style={{ fontSize: 11, color: "#94A3B8", whiteSpace: "nowrap" }}>
              统计范围：{data.dataScope} · 截至 {data.today}
            </span>
          ) : null}
        </div>

        {loading ? (
          <Skeleton />
        ) : error || !data || !kpi ? (
          <div style={{ ...CARD, textAlign: "center", padding: "48px 24px" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#DC2626", marginBottom: 6 }}>数据加载失败</div>
            <div style={{ fontSize: 12, color: "#64748B", marginBottom: 16 }}>{error ?? "未获取到统计数据"}</div>
            <button
              onClick={() => void load()}
              style={{
                padding: "8px 18px",
                borderRadius: 8,
                border: "1px solid #2563EB",
                background: "#2563EB",
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              重新加载
            </button>
          </div>
        ) : (
          <>
            {/* ====== 顶部核心数据卡片 ====== */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 20 }}>
              <div style={{ ...CARD, display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, background: "#EFF6FF", display: "flex", alignItems: "center", justifyContent: "center", color: "#2563EB", flexShrink: 0 }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="22" height="22" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#64748B", fontWeight: 500 }}>本月成交额</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "#0F172A", marginTop: 2 }}>{money(kpi.salesAmount.value)}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, marginTop: 2 }}>
                    <Delta kpi={kpi.salesAmount} format={money} />
                  </div>
                </div>
              </div>

              <div style={{ ...CARD, display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, background: "#F0FDF4", display: "flex", alignItems: "center", justifyContent: "center", color: "#059669", flexShrink: 0 }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="22" height="22" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#64748B", fontWeight: 500 }}>本月新增线索</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "#0F172A", marginTop: 2 }}>{kpi.leadCount.value}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, marginTop: 2 }}>
                    <Delta kpi={kpi.leadCount} format={(v) => `${v} 条`} />
                  </div>
                </div>
              </div>

              <div style={{ ...CARD, display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, background: "#FFF7ED", display: "flex", alignItems: "center", justifyContent: "center", color: "#D97706", flexShrink: 0 }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="22" height="22" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#64748B", fontWeight: 500 }}>本月订单数</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "#0F172A", marginTop: 2 }}>{kpi.orderCount.value}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, marginTop: 2 }}>
                    <Delta kpi={kpi.orderCount} format={(v) => `${v} 单`} />
                  </div>
                </div>
              </div>

              <div style={{ ...CARD, display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, background: "#F5F3FF", display: "flex", alignItems: "center", justifyContent: "center", color: "#7C3AED", flexShrink: 0 }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="22" height="22" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                  </svg>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#64748B", fontWeight: 500 }}>线索转化率</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "#0F172A", marginTop: 2 }}>{percent(kpi.conversionRate)}</div>
                  <div style={{ fontSize: 11, color: "#64748B", fontWeight: 500, marginTop: 2 }}>
                    成交 {kpi.deals} / 线索 {kpi.leadsTotal}
                  </div>
                </div>
              </div>
            </div>

            {/* ====== 线索状态分布 ====== */}
            <StatusMixBar statusMix={data.statusMix} total={kpi.leadsTotal} />

            {/* ====== 业绩趋势图 ====== */}
            <div style={{ marginBottom: 20 }}>
              <TrendCharts trend={data.trend} />
            </div>

            {/* ====== 第二行：线索来源 + 漏斗 + 商品统计 ====== */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 20 }}>
              <BarChartWidget
                title="线索来源排行榜"
                data={data.sources.map((row) => ({ label: row.key, value: row.count }))}
                label="线索数"
                color="#3B82F6"
              />
              <FunnelChart funnel={data.funnel} leadsTotal={kpi.leadsTotal} />
              <PieChartWidget
                title="售卖商品统计"
                data={data.products.map((row) => ({ label: row.label, value: row.amount }))}
              />
            </div>

            {/* ====== 销售人员业绩排行榜 ====== */}
            <SalesRanking ranking={data.ranking} />
          </>
        )}
      </main>
    </div>
  );
}
