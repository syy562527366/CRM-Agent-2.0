"use client";

/**
 * 工具调用面板（参考 agent-chat-ui 素材包）
 *
 * 展示规则：
 * - 每个工具调用占一行，按执行顺序编号；
 * - 默认全部收起，点一行才展开参数与返回值；
 * - 收起状态也能看到「调了什么工具 + 关键参数 + 当前状态」，不用逐条点开；
 * - 状态色：执行中蓝 / 完成绿 / 失败红 / 待审批黄 / 已批准绿 / 已拒绝红。
 */
import { useState } from "react";
import { Chevron, ToolIcon } from "./Atoms";

export type ToolStatus = "running" | "done" | "error" | "pending_approval" | "approved" | "rejected";

export interface ToolCallView {
  id?: string;
  name: string;
  args?: Record<string, unknown> | string;
  result?: string | null;
  status?: ToolStatus;
  description?: string;
}

/** 工具的中文名，让一行里能直接读懂「在干什么」 */
const TOOL_LABEL: Record<string, string> = {
  calculator: "计算",
  get_current_time: "当前时间",
  crm_search_leads: "查询线索",
  crm_get_lead: "线索详情",
  crm_get_lead_timeline: "沟通记录",
  crm_search_orders: "查询订单",
  crm_list_products: "商品列表",
  crm_lead_stats: "线索统计",
  crm_sales_stats: "销售统计",
  write_todos: "任务拆解",
  ls: "浏览目录",
  read_file: "读取文件",
  write_file: "写入文件",
  edit_file: "编辑文件",
  task: "子任务",
};

/** 已知工具的用途说明（后端暂未回传 description） */
const TOOL_DESC: Record<string, string> = {
  calculator: "数学计算（四则运算 / 乘方 / 括号）",
  get_current_time: "获取指定时区的当前时间",
  crm_search_leads: "按状态 / 优先级 / 来源 / 负责人 / 关键词检索线索，返回摘要列表",
  crm_get_lead: "按线索编号查看单条线索详情（手机号默认脱敏）",
  crm_get_lead_timeline: "查看某条线索最近的沟通记录",
  crm_search_orders: "检索订单，可按客户 / 商品 / 金额 / 日期筛选",
  crm_list_products: "列出在售商品及价格",
  crm_lead_stats: "线索分组统计（状态漏斗 / 来源分布 / 负责人负载）",
  crm_sales_stats: "销售统计（成交额 / 订单数 / 客单价）",
  write_todos: "拆解并维护任务清单",
  ls: "浏览虚拟文件系统目录",
  read_file: "读取虚拟文件系统中的文件",
  write_file: "写入虚拟文件系统中的文件",
  task: "派发子 Agent 执行独立任务",
};

/** 参数名 → 中文标签，用于收起状态下的一行摘要 */
const ARG_LABEL: Record<string, string> = {
  status: "状态",
  priority: "优先级",
  source: "来源",
  keyword: "关键词",
  assignee: "负责人",
  group_by: "维度",
  sort: "排序",
  limit: "条数",
  date_from: "起",
  date_to: "止",
  lead_id: "线索",
  customer: "客户",
  product: "商品",
  min_amount: "金额≥",
  file_path: "路径",
  expression: "表达式",
  timezone: "时区",
};

const STATE_STYLE: Record<ToolStatus, { bg: string; border: string; dot: string; text: string; label: string }> = {
  running: { bg: "#F0F9FF", border: "#BFDBFE", dot: "#3B82F6", text: "#1D4ED8", label: "执行中" },
  done: { bg: "#F7FEF9", border: "#BBF7D0", dot: "#16A34A", text: "#15803D", label: "完成" },
  error: { bg: "#FFF7F7", border: "#FECACA", dot: "#EF4444", text: "#B91C1C", label: "失败" },
  pending_approval: { bg: "#FFFBEB", border: "#FCD34D", dot: "#F59E0B", text: "#B45309", label: "待审批" },
  approved: { bg: "#F7FEF9", border: "#BBF7D0", dot: "#16A34A", text: "#15803D", label: "已批准" },
  rejected: { bg: "#FFF7F7", border: "#FECACA", dot: "#EF4444", text: "#B91C1C", label: "已拒绝" },
};

/** 后端只回传「有结果 / 无结果」，这里补一层错误识别 */
function resolveStatus(tool: ToolCallView): ToolStatus {
  if (tool.status) return tool.status;
  if (tool.result === undefined || tool.result === null) return "running";
  if (/^(计算失败|失败|错误)|Error|Traceback|Exception|失败：/.test(tool.result)) return "error";
  // 工具统一返回 {"ok": false, ...} 信封，也判为失败
  if (/"ok"\s*:\s*false/.test(tool.result)) return "error";
  return "done";
}

function labelOf(name: string): string {
  return TOOL_LABEL[name] ?? name;
}

function formatArgs(args?: Record<string, unknown> | string): string {
  if (!args) return "";
  if (typeof args === "string") return args;
  const entries = Object.entries(args);
  if (!entries.length) return "";
  if (entries.length === 1 && typeof entries[0][1] !== "object") return String(entries[0][1]);
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/** 收起状态下的参数摘要：最多挑 3 个有值的参数，例如「状态=成交 · 条数=3」 */
function summarizeArgs(args?: Record<string, unknown> | string): string {
  if (!args || typeof args === "string") return typeof args === "string" ? args.slice(0, 60) : "";

  // sort 这类默认值对用户没意义，不进摘要
  const NOISE = new Set(["sort"]);

  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (NOISE.has(key)) continue;
    if (value === "" || value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "object") continue;

    const label = ARG_LABEL[key] ?? key;
    const shown = typeof value === "string" ? value : String(value);
    parts.push(`${label}=${shown.length > 18 ? `${shown.slice(0, 18)}…` : shown}`);
    if (parts.length >= 3) break;
  }
  return parts.join(" · ");
}

export default function ToolPanel({
  tools,
  onApprove,
  onReject,
}: {
  tools: ToolCallView[];
  onApprove?: (tool: ToolCallView) => void;
  onReject?: (tool: ToolCallView) => void;
}) {
  // 默认全部收起：key 不存在即折叠
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (!tools.length) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        marginBottom: 8,
        alignSelf: "stretch",
      }}
    >
      {tools.map((tool, index) => {
        const key = tool.id || `${tool.name}-${index}`;
        const status = resolveStatus(tool);
        const s = STATE_STYLE[status];
        const open = !!expanded[key];
        const argsText = formatArgs(tool.args);
        const summary = summarizeArgs(tool.args);
        const desc = tool.description || TOOL_DESC[tool.name];
        const canExpand = Boolean(argsText || tool.result || desc);

        const toggle = () => {
          if (!canExpand) return;
          setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
        };

        return (
          <div
            key={key}
            style={{
              background: s.bg,
              border: `1px solid ${s.border}`,
              borderRadius: 8,
              overflow: "hidden",
              transition: "background .15s ease, border-color .15s ease",
            }}
          >
            <div
              onClick={toggle}
              role="button"
              tabIndex={0}
              aria-expanded={open}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle();
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "5px 9px",
                cursor: canExpand ? "pointer" : "default",
                userSelect: "none",
                minWidth: 0,
                overflow: "hidden",
              }}
            >
              {/* 状态图标 */}
              <span
                style={{
                  width: 14,
                  height: 14,
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "50%",
                  background: status === "running" ? s.dot : "transparent",
                  ...(status === "running" ? { animation: "pulse-dot 1.2s infinite ease-in-out" } : {}),
                }}
              >
                {status === "done" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke={s.dot} strokeWidth="3" width="13" height="13" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
                {(status === "error" || status === "rejected") && (
                  <svg viewBox="0 0 24 24" fill="none" stroke={s.dot} strokeWidth="3" width="13" height="13" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                )}
                {status === "pending_approval" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke={s.dot} strokeWidth="2.4" width="13" height="13" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                )}
                {status === "approved" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke={s.dot} strokeWidth="2.4" width="13" height="13" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <polyline points="8.5 12 11 14.5 15.5 10" />
                  </svg>
                )}
              </span>

              {/* 序号：体现调用顺序 */}
              <span style={{ fontSize: 11, color: "#94A3B8", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                {index + 1}
              </span>

              <ToolIcon name={tool.name} size={12} color="#64748B" />

              <span style={{ fontSize: 12.5, fontWeight: 600, color: "#334155", whiteSpace: "nowrap" }}>
                {labelOf(tool.name)}
              </span>

              {labelOf(tool.name) !== tool.name && (
                <code
                  style={{
                    fontSize: 10.5,
                    color: "#94A3B8",
                    fontFamily: '"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace',
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: 150,
                    flexShrink: 1,
                    minWidth: 0,
                  }}
                >
                  {tool.name}
                </code>
              )}

              <div style={{ flex: 1, minWidth: 6 }} />

              {summary && (
                <span
                  title={summary}
                  style={{
                    fontSize: 11.5,
                    color: "#64748B",
                    maxWidth: 300,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flexShrink: 1,
                    minWidth: 0,
                  }}
                >
                  {summary}
                </span>
              )}

              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: s.text,
                  background: "#fff",
                  border: `1px solid ${s.border}`,
                  borderRadius: 999,
                  padding: "0 7px",
                  lineHeight: "17px",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {s.label}
              </span>

              {canExpand && <Chevron open={open} />}
            </div>

            {open && canExpand && (
              <div
                style={{
                  padding: "7px 12px 10px 30px",
                  borderTop: `1px solid ${s.border}`,
                  fontSize: 12.5,
                  color: "#475569",
                  lineHeight: 1.6,
                  background: "rgba(255,255,255,0.55)",
                }}
              >
                {desc && <div style={{ marginBottom: 4, fontWeight: 600, color: "#334155" }}>{desc}</div>}
                {argsText && (
                  <div style={{ marginBottom: 6 }}>
                    <span style={{ display: "block", fontSize: 11, color: "#94A3B8", marginBottom: 2 }}>参数</span>
                    <code
                      style={{
                        fontFamily: '"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace',
                        fontSize: 11.5,
                        color: "#64748B",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {argsText}
                    </code>
                  </div>
                )}
                {tool.result !== undefined && tool.result !== null && (
                  <div>
                    <span style={{ display: "block", fontSize: 11, color: "#94A3B8", marginBottom: 3 }}>返回</span>
                    <div
                      style={{
                        marginTop: 3,
                        padding: "7px 10px",
                        background: "#fff",
                        border: `1px solid ${s.border}`,
                        borderRadius: 7,
                        fontSize: 12,
                        color: status === "error" ? "#B91C1C" : "#334155",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        maxHeight: 220,
                        overflowY: "auto",
                        fontFamily: '"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace',
                        lineHeight: 1.65,
                      }}
                    >
                      {tool.result}
                    </div>
                  </div>
                )}
              </div>
            )}

            {status === "pending_approval" && onApprove && onReject && (
              <div style={{ display: "flex", gap: 8, padding: "8px 12px 10px 30px", borderTop: `1px solid ${s.border}` }}>
                <button
                  onClick={() => onApprove(tool)}
                  style={{
                    padding: "5px 16px",
                    borderRadius: 7,
                    border: "none",
                    background: "#22C55E",
                    color: "#fff",
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  批准执行
                </button>
                <button
                  onClick={() => onReject(tool)}
                  style={{
                    padding: "5px 16px",
                    borderRadius: 7,
                    border: "1px solid #FCA5A5",
                    background: "#fff",
                    color: "#DC2626",
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  拒绝
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
