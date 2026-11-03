"use client";

/**
 * 工具调用面板（参考 agent-chat-ui 素材包）
 * 六态状态色：执行中蓝 / 完成绿 / 失败红 / 待审批黄 / 已批准绿 / 已拒绝红
 * 支持展开查看参数与返回值、脉冲圆点、审批回调
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

/** 已知工具的用途说明（后端暂未回传 description） */
const TOOL_DESC: Record<string, string> = {
  calculator: "数学计算（四则运算 / 乘方 / 括号）",
  get_current_time: "获取指定时区的当前时间",
  crm_read_leads: "读取 CRM 线索数据（可按状态 / 意向等级 / 关键词筛选）",
  write_todos: "拆解并维护任务清单",
  ls: "浏览虚拟文件系统目录",
  read_file: "读取虚拟文件系统中的文件",
  write_file: "写入虚拟文件系统中的文件",
  task: "派发子 Agent 执行独立任务",
};

const STATE_STYLE: Record<ToolStatus, { bg: string; border: string; dot: string; label: string }> = {
  running: { bg: "#F0F9FF", border: "#93C5FD", dot: "#3B82F6", label: "执行中" },
  done: { bg: "#F0FDF4", border: "#86EFAC", dot: "#22C55E", label: "完成" },
  error: { bg: "#FFF5F5", border: "#FECACA", dot: "#EF4444", label: "失败" },
  pending_approval: { bg: "#FFFBEB", border: "#FCD34D", dot: "#F59E0B", label: "待审批" },
  approved: { bg: "#F0FDF4", border: "#86EFAC", dot: "#22C55E", label: "已批准" },
  rejected: { bg: "#FEF2F2", border: "#FECACA", dot: "#EF4444", label: "已拒绝" },
};

/** 后端只回传「有结果 / 无结果」，这里补一层错误识别 */
function resolveStatus(tool: ToolCallView): ToolStatus {
  if (tool.status) return tool.status;
  if (tool.result === undefined || tool.result === null) return "running";
  if (/^(计算失败|失败|错误)|Error|Traceback|Exception|失败：/.test(tool.result)) return "error";
  return "done";
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

export default function ToolPanel({
  tools,
  onApprove,
  onReject,
}: {
  tools: ToolCallView[];
  onApprove?: (tool: ToolCallView) => void;
  onReject?: (tool: ToolCallView) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (!tools.length) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
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
        const desc = tool.description || TOOL_DESC[tool.name];
        const canExpand = Boolean(argsText || tool.result || desc);

        return (
          <div
            key={key}
            style={{
              background: s.bg,
              border: `1px solid ${s.border}`,
              borderRadius: 9,
              overflow: "hidden",
              transition: "background .15s ease, border-color .15s ease",
            }}
          >
            <div
              onClick={() => canExpand && setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && canExpand) {
                  e.preventDefault();
                  setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px 6px 11px",
                cursor: canExpand ? "pointer" : "default",
                userSelect: "none",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: s.dot,
                  flexShrink: 0,
                  ...(status === "running" ? { animation: "pulse-dot 1.2s infinite ease-in-out" } : {}),
                }}
              />
              <ToolIcon name={tool.name} size={13} color="#475569" />
              <code
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: "#334155",
                  fontFamily: '"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace',
                  whiteSpace: "nowrap",
                }}
              >
                {tool.name}
              </code>
              <span style={{ fontSize: 11.5, color: s.dot, fontWeight: 600, whiteSpace: "nowrap" }}>{s.label}</span>
              <div style={{ flex: 1, minWidth: 8 }} />
              {canExpand && <Chevron open={open} />}
            </div>

            {open && canExpand && (
              <div
                style={{
                  padding: "7px 12px 10px 27px",
                  borderTop: `1px solid ${s.border}`,
                  fontSize: 12.5,
                  color: "#475569",
                  lineHeight: 1.6,
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
                        background: "rgba(255,255,255,0.72)",
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
              <div style={{ display: "flex", gap: 8, padding: "8px 12px 10px 27px", borderTop: `1px solid ${s.border}` }}>
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
