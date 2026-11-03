"use client";

/**
 * 工具数据卡片。
 *
 * 工具调用只把「摘要 + 条数」交给模型，完整明细由服务端通过 SSE `tool_data`
 * 事件单独推给前端，在这里渲染成表格。好处：
 * - 不占用上下文，多轮对话不会被几十行数据拖垮；
 * - 表格数据不经过模型转述，不会出现「照着 JSON 念」的失真；
 * - 明细不写入 messages[].content，后续追问时模型仍然只看摘要。
 */

export interface DataTableColumn {
  key: string;
  label?: string;
  align?: "left" | "right";
}

export interface DataTableCardData {
  /** lead_table / order_table / stat_table …，仅用于标题兜底 */
  kind?: string;
  /** 卡片标题，如「客户线索」 */
  title?: string;
  /** 产生数据的工具名 */
  tool?: string;
  columns: DataTableColumn[];
  rows: Record<string, unknown>[];
  /** 符合条件的总条数（rows 可能只是前 N 条） */
  total?: number;
}

const COLUMN_LABEL: Record<string, string> = {
  id: "编号",
  name: "客户姓名",
  customerName: "客户姓名",
  status: "状态",
  priority: "优先级",
  assignee: "负责人",
  source: "来源",
  lastFollowUpAt: "最近跟进",
  createdAt: "创建时间",
  sentAt: "时间",
  phone: "手机号",
  amount: "金额",
  productName: "商品",
  productNo: "商品编号",
  orderNo: "订单号",
  intentProduct: "意向产品",
  budgetRange: "预算",
  count: "数量",
  key: "分组",
  channel: "渠道",
  content: "内容",
  sender: "发送人",
  avgAmount: "客单价",
};

const KIND_TITLE: Record<string, string> = {
  lead_table: "客户线索",
  order_table: "订单明细",
  stat_table: "统计结果",
  communication_table: "沟通记录",
};

const STATUS_COLOR: Record<string, { bg: string; color: string }> = {
  成交: { bg: "#ECFDF5", color: "#047857" },
  客户流失: { bg: "#FEF2F2", color: "#B91C1C" },
  长期未跟进: { bg: "#FFFBEB", color: "#B45309" },
  未接触: { bg: "#F1F5F9", color: "#475569" },
};

const PRIORITY_COLOR: Record<string, { bg: string; color: string }> = {
  high: { bg: "#FEF2F2", color: "#B91C1C" },
  medium: { bg: "#FFFBEB", color: "#B45309" },
  low: { bg: "#F1F5F9", color: "#475569" },
};

const MAX_ROWS = 50;

/** 工具可能只给 key 列表，这里统一成带 label 的列 */
export function normalizeColumns(columns: (string | DataTableColumn)[]): DataTableColumn[] {
  return columns.map((column) =>
    typeof column === "string" ? { key: column, label: COLUMN_LABEL[column] ?? column } : column,
  );
}

function isNumericColumn(rows: Record<string, unknown>[], key: string): boolean {
  return rows.some((row) => typeof row[key] === "number");
}

function renderCell(value: unknown, key: string) {
  if (value === null || value === undefined || value === "") {
    return <span style={{ color: "#CBD5E1" }}>—</span>;
  }

  if (key === "status" && typeof value === "string" && STATUS_COLOR[value]) {
    const style = STATUS_COLOR[value];
    return <Chip style={style}>{value}</Chip>;
  }
  if (key === "priority" && typeof value === "string" && PRIORITY_COLOR[value]) {
    const style = PRIORITY_COLOR[value];
    const label = { high: "高", medium: "中", low: "低" }[value] ?? value;
    return <Chip style={style}>{label}</Chip>;
  }
  if (typeof value === "number") return value.toLocaleString("zh-CN");

  return String(value);
}

function Chip({ children, style }: { children: React.ReactNode; style: { bg: string; color: string } }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 7px",
        borderRadius: 999,
        background: style.bg,
        color: style.color,
        fontSize: 11.5,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export default function DataTableCard({ data }: { data: DataTableCardData }) {
  const columns = normalizeColumns(data.columns ?? []);
  const rows = (data.rows ?? []).slice(0, MAX_ROWS);
  const total = data.total ?? data.rows?.length ?? 0;
  const title = data.title || (data.kind ? KIND_TITLE[data.kind] : "") || "查询结果";

  if (!columns.length) return null;

  return (
    <div
      style={{
        marginBottom: 8,
        border: "1px solid #E2E8F0",
        borderRadius: 10,
        background: "#fff",
        overflow: "hidden",
        boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid #EEF2F7",
          background: "#FCFDFE",
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18M9 10v10" />
        </svg>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "#334155" }}>{title}</span>
        <span style={{ fontSize: 11.5, color: "#94A3B8" }}>
          共 {total} 条{rows.length < total ? `，显示前 ${rows.length} 条` : ""}
        </span>
        <div style={{ flex: 1 }} />
        {data.tool && (
          <code style={{ fontSize: 11, color: "#94A3B8", fontFamily: '"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace' }}>
            {data.tool}
          </code>
        )}
      </div>

      <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: 340 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr>
              {columns.map((column, index) => {
                const numeric = isNumericColumn(rows, column.key);
                return (
                  <th
                    key={column.key}
                    style={{
                      position: "sticky",
                      top: 0,
                      zIndex: 1,
                      textAlign: numeric ? "right" : "left",
                      padding: index === 0 ? "7px 12px" : "7px 12px",
                      background: "#F8FAFC",
                      borderBottom: "1px solid #E2E8F0",
                      color: "#64748B",
                      fontWeight: 600,
                      fontSize: 11.5,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {column.label || COLUMN_LABEL[column.key] || column.key}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  style={{ padding: "18px 12px", textAlign: "center", color: "#94A3B8", fontSize: 12.5 }}
                >
                  没有符合条件的记录
                </td>
              </tr>
            ) : (
              rows.map((row, rowIndex) => (
                <tr key={rowIndex} style={{ background: rowIndex % 2 ? "#FCFDFE" : "#fff" }}>
                  {columns.map((column) => {
                    const numeric = isNumericColumn(rows, column.key);
                    return (
                      <td
                        key={column.key}
                        style={{
                          padding: "7px 12px",
                          borderBottom: rowIndex === rows.length - 1 ? "none" : "1px solid #F1F5F9",
                          color: "#334155",
                          textAlign: numeric ? "right" : "left",
                          whiteSpace: "nowrap",
                          fontVariantNumeric: numeric ? "tabular-nums" : undefined,
                        }}
                      >
                        {renderCell(row[column.key], column.key)}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
