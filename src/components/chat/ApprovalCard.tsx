"use client";

/**
 * 人工审批卡（Agent 修改数据前的确认关卡）
 *
 * 白皮书约定：
 * - 修改类工具（crm_update_lead / crm_update_order）每次调用都会暂停，
 *   由这张卡片拿到用户的「批准 / 拒绝」，再 POST /chat/resume 继续；
 * - 删除类工具不注册给 Agent，所以这里不会出现删除操作；
 * - 批准后工具内部仍会做权限位与字段白名单校验，审批不是「放行开关」。
 *
 * 交互取舍：
 * - 单项（绝大多数情况）：两个按钮直接提交，不多一次点击；
 * - 多项：逐项选择后再统一提交 —— 后端 batched 模式按数组下标匹配决策，
 *   所以必须一次性回传全部决策，不能一项一项发。
 */
import { useState } from "react";

export interface ApprovalField {
  key: string;
  label: string;
  value: string;
}

export interface ApprovalAction {
  index: number;
  tool: string;
  label: string;
  target?: string;
  summary?: string;
  fields?: ApprovalField[];
  args?: Record<string, unknown>;
  allowed_decisions?: string[];
}

export interface ApprovalPayload {
  thread_id: string;
  interrupt_id: string;
  actions: ApprovalAction[];
  mode?: string;
}

export interface ApprovalDecision {
  type: "approve" | "reject";
  message?: string;
}

type Choice = "approve" | "reject";

export default function ApprovalCard({
  data,
  resolved,
  submitting,
  onResolve,
}: {
  data: ApprovalPayload;
  /** 已处理过的卡片只展示结论，不再可点 */
  resolved?: "approved" | "rejected" | null;
  submitting?: boolean;
  onResolve?: (decisions: ApprovalDecision[]) => void;
}) {
  const actions = data.actions ?? [];
  const multiple = actions.length > 1;
  const [picked, setPicked] = useState<Record<number, Choice>>({});
  const [reason, setReason] = useState("");
  const [reasonOpen, setReasonOpen] = useState(false);

  const locked = Boolean(resolved) || Boolean(submitting);
  const allPicked = actions.every((a) => picked[a.index]);

  const submit = (decisions: ApprovalDecision[]) => {
    if (locked || !onResolve) return;
    const text = reason.trim();
    onResolve(
      decisions.map((d) =>
        d.type === "reject" && text ? { ...d, message: text } : d,
      ),
    );
  };

  const choose = (action: ApprovalAction, choice: Choice) => {
    if (locked) return;
    if (!multiple) {
      // 单项：点了就提交，不再要求二次确认
      submit([{ type: choice }]);
      return;
    }
    setPicked((prev) => ({ ...prev, [action.index]: choice }));
  };

  const resolvedLabel =
    resolved === "approved" ? "已批准执行" : resolved === "rejected" ? "已拒绝，数据未改动" : "";

  return (
    <div
      style={{
        alignSelf: "stretch",
        marginBottom: 8,
        borderRadius: 12,
        border: `1px solid ${resolved ? "#E2E8F0" : "#FCD34D"}`,
        background: resolved ? "#F8FAFC" : "#FFFBEB",
        overflow: "hidden",
        boxShadow: resolved ? "none" : "0 2px 8px rgba(245,158,11,0.10)",
      }}
    >
      {/* 头部 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "9px 12px",
          borderBottom: `1px solid ${resolved ? "#E2E8F0" : "#FDE68A"}`,
          minWidth: 0,
        }}
      >
        <span
          style={{
            width: 18,
            height: 18,
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 6,
            background: resolved ? "#E2E8F0" : "#FDE68A",
            color: resolved ? "#64748B" : "#B45309",
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" width="12" height="12" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
            <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
        </span>

        <span style={{ fontSize: 12.5, fontWeight: 700, color: resolved ? "#475569" : "#92400E", whiteSpace: "nowrap" }}>
          {resolved ? resolvedLabel : "需要你确认后才能执行"}
        </span>

        {!resolved && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "#B45309",
              background: "#FEF3C7",
              border: "1px solid #FDE68A",
              borderRadius: 999,
              padding: "0 7px",
              lineHeight: "17px",
              flexShrink: 0,
            }}
          >
            {actions.length} 项待审批
          </span>
        )}

        <div style={{ flex: 1, minWidth: 4 }} />

        {!resolved && (
          <span style={{ fontSize: 11, color: "#B45309", whiteSpace: "nowrap", opacity: 0.85 }}>
            修改类操作
          </span>
        )}
      </div>

      {/* 操作明细 */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {actions.map((action) => {
          const choice = picked[action.index];
          return (
            <div
              key={`${action.index}-${action.tool}`}
              style={{
                padding: "9px 12px",
                borderTop: action.index === 0 ? "none" : "1px solid rgba(253,230,138,0.7)",
                background: choice === "reject" ? "#FFF7F7" : "#fff",
                minWidth: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "#0F172A" }}>{action.label}</span>
                <code
                  style={{
                    fontSize: 10.5,
                    color: "#94A3B8",
                    fontFamily: '"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace',
                  }}
                >
                  {action.tool}
                </code>
                {action.target && (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: "#1D4ED8",
                      background: "#EFF6FF",
                      border: "1px solid #DBEAFE",
                      borderRadius: 6,
                      padding: "0 6px",
                      lineHeight: "17px",
                    }}
                  >
                    {action.target}
                  </span>
                )}
              </div>

              {/* 字段级改动 */}
              {action.fields && action.fields.length > 0 ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
                  {action.fields.map((field) => (
                    <span
                      key={field.key}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "2px 8px",
                        borderRadius: 6,
                        background: "#F8FAFC",
                        border: "1px solid #E2E8F0",
                        fontSize: 11.5,
                        color: "#334155",
                        maxWidth: "100%",
                      }}
                    >
                      <span style={{ color: "#64748B" }}>{field.label}</span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2.4" width="10" height="10" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12h14M13 6l6 6-6 6" />
                      </svg>
                      <strong style={{ color: "#0F172A", fontWeight: 600 }}>{field.value}</strong>
                    </span>
                  ))}
                </div>
              ) : (
                <div style={{ marginTop: 6, fontSize: 11.5, color: "#64748B" }}>
                  {action.summary || "（未识别到具体字段变化）"}
                </div>
              )}

              {/* 多项时逐项选择 */}
              {multiple && !locked && (
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <ChoiceChip
                    active={choice === "approve"}
                    tone="approve"
                    onClick={() => choose(action, "approve")}
                  >
                    批准
                  </ChoiceChip>
                  <ChoiceChip
                    active={choice === "reject"}
                    tone="reject"
                    onClick={() => choose(action, "reject")}
                  >
                    拒绝
                  </ChoiceChip>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 底部操作区 */}
      {!resolved && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px 10px",
            borderTop: "1px solid #FDE68A",
            flexWrap: "wrap",
          }}
        >
          {reasonOpen ? (
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="拒绝理由（可选，会告诉 AI，让它别重试）"
              style={{
                flex: 1,
                minWidth: 160,
                fontSize: 12,
                padding: "5px 9px",
                borderRadius: 7,
                border: "1px solid #E2E8F0",
                outline: "none",
                fontFamily: "inherit",
                color: "#334155",
                background: "#fff",
              }}
            />
          ) : (
            <button
              onClick={() => setReasonOpen(true)}
              style={{
                border: "none",
                background: "transparent",
                color: "#B45309",
                fontSize: 11.5,
                cursor: "pointer",
                padding: 0,
                fontFamily: "inherit",
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              添加拒绝理由
            </button>
          )}

          <div style={{ flex: 1, minWidth: 8 }} />

          {multiple ? (
            <button
              onClick={() => {
                if (!allPicked) return;
                submit(
                  actions.map((a) => ({ type: picked[a.index] ?? "reject" })),
                );
              }}
              disabled={!allPicked || submitting}
              style={{
                padding: "5px 16px",
                borderRadius: 7,
                border: "none",
                background: allPicked && !submitting ? "#2563EB" : "#E2E8F0",
                color: allPicked && !submitting ? "#fff" : "#94A3B8",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: allPicked && !submitting ? "pointer" : "not-allowed",
                fontFamily: "inherit",
              }}
            >
              {submitting ? "提交中…" : `提交 ${actions.length} 项决策`}
            </button>
          ) : (
            <>
              <button
                onClick={() => choose(actions[0], "reject")}
                disabled={submitting}
                style={{
                  padding: "5px 16px",
                  borderRadius: 7,
                  border: "1px solid #FCA5A5",
                  background: "#fff",
                  color: "#DC2626",
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: submitting ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                拒绝
              </button>
              <button
                onClick={() => choose(actions[0], "approve")}
                disabled={submitting}
                style={{
                  padding: "5px 18px",
                  borderRadius: 7,
                  border: "none",
                  background: submitting ? "#86EFAC" : "#16A34A",
                  color: "#fff",
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: submitting ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                {submitting ? "执行中…" : "批准执行"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ChoiceChip({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: "approve" | "reject";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const color = tone === "approve" ? "#16A34A" : "#DC2626";
  return (
    <button
      onClick={onClick}
      style={{
        padding: "3px 12px",
        borderRadius: 999,
        border: `1px solid ${active ? color : "#E2E8F0"}`,
        background: active ? (tone === "approve" ? "#F0FDF4" : "#FFF1F2") : "#fff",
        color: active ? color : "#64748B",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}
