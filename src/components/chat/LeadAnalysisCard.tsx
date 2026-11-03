"use client";

/**
 * 线索分析卡片（参考 agent-chat-ui 素材包）
 * AI 在 ```lead-analysis-card 围栏里输出 JSON 时，Markdown 渲染器会把它变成这张结构化卡片
 */
export interface Competitor {
  name: string;
  attitude: "positive" | "neutral" | "negative" | "price_sensitive";
  quote?: string;
}

export interface ActionItem {
  title: string;
  detail: string;
}

export interface LeadAnalysisData {
  customer: string;
  leadId: string;
  intent: "high" | "medium" | "low";
  intentProduct: string;
  budget: string;
  commCount: number;
  lastCommDate?: string;
  competitors?: Competitor[];
  actions?: ActionItem[];
  degraded?: boolean;
}

const INTENT: Record<string, { bg: string; dot: string; text: string; label: string }> = {
  high: { bg: "#FEF2F2", dot: "#EF4444", text: "#DC2626", label: "高" },
  medium: { bg: "#FFFBEB", dot: "#F59E0B", text: "#D97706", label: "中" },
  low: { bg: "#F8FAFC", dot: "#94A3B8", text: "#64748B", label: "低" },
};

const ATTITUDE: Record<string, { bg: string; color: string; label: string }> = {
  positive: { bg: "#DCFCE7", color: "#16A34A", label: "积极" },
  neutral: { bg: "#F1F5F9", color: "#64748B", label: "中性" },
  negative: { bg: "#FEE2E2", color: "#DC2626", label: "负面" },
  price_sensitive: { bg: "#FEF3C7", color: "#D97706", label: "价格敏感" },
};

export default function LeadAnalysisCard({ data }: { data: LeadAnalysisData }) {
  const ic = INTENT[data.intent] ?? INTENT.medium;
  const degraded = !!data.degraded;
  const actions = data.actions ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: "100%" }}>
      {/* 客户 + 意向 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          borderRadius: 10,
          background: degraded ? "#F1F5F9" : ic.bg,
        }}
      >
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: degraded ? "#94A3B8" : "linear-gradient(135deg, #2563EB, #7C3AED)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontSize: 15,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {String(data.customer ?? "?").charAt(0)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1E293B" }}>{data.customer}</div>
          <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 1 }}>
            {data.leadId} · {data.commCount} 轮沟通
            {data.lastCommDate ? ` · ${data.lastCommDate}` : ""}
          </div>
        </div>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            background: "rgba(255,255,255,0.68)",
            borderRadius: 6,
            padding: "4px 10px",
            flexShrink: 0,
            border: `1px solid ${ic.dot}33`,
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: ic.dot, flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: ic.text }}>意向 {ic.label}</span>
        </div>
        {degraded && (
          <span
            style={{
              background: "#F1F5F9",
              color: "#64748B",
              fontSize: 11,
              fontWeight: 600,
              padding: "3px 8px",
              borderRadius: 5,
              flexShrink: 0,
            }}
          >
            降级
          </span>
        )}
      </div>

      {/* 预算 / 意向产品 */}
      <div style={{ display: "flex", gap: 8, overflow: "hidden" }}>
        <div style={{ flex: 1, minWidth: 0, background: "#F8FAFC", borderRadius: 10, padding: "10px 14px" }}>
          <div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 500 }}>预算范围</div>
          <div style={{ fontSize: 15.5, fontWeight: 600, color: "#1E293B", marginTop: 2 }}>{data.budget || "—"}</div>
        </div>
        <div style={{ flex: 1, minWidth: 0, background: "#F8FAFC", borderRadius: 10, padding: "10px 14px" }}>
          <div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 500 }}>意向产品</div>
          <div
            style={{
              fontSize: 15.5,
              fontWeight: 600,
              color: "#1E293B",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {data.intentProduct || "—"}
          </div>
        </div>
      </div>

      {/* 竞品提及 */}
      <div style={{ background: "#fff", border: "1px solid #F1F5F9", borderRadius: 10, padding: "10px 14px" }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: "#475569", marginBottom: 8 }}>竞品提及</div>
        {data.competitors && data.competitors.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {data.competitors.map((c, i) => {
              const a = ATTITUDE[c.attitude] ?? ATTITUDE.neutral;
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 6,
                    background: a.bg,
                    borderRadius: 8,
                    padding: "6px 12px",
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600, color: a.color, flexShrink: 0, lineHeight: 1.5 }}>
                    {c.name}
                  </span>
                  <span style={{ fontSize: 10.5, color: a.color, opacity: 0.8, flexShrink: 0, marginTop: 2 }}>
                    {a.label}
                  </span>
                  {c.quote && (
                    <span style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.5, wordBreak: "break-word" }}>
                      「{c.quote}」
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: "#94A3B8" }}>暂无竞品提及</div>
        )}
      </div>

      {/* 建议跟进动作 */}
      <div style={{ background: "#fff", border: "1px solid #F1F5F9", borderRadius: 10, padding: "10px 14px" }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: "#475569", marginBottom: 8 }}>建议跟进动作</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {actions.length === 0 && <div style={{ fontSize: 12.5, color: "#94A3B8" }}>暂无建议</div>}
          {actions.map((a, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                background: "#F8FAFC",
                borderRadius: 8,
                padding: "8px 10px",
              }}
            >
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 5,
                  background: "#EEF2FF",
                  color: "#4338CA",
                  fontSize: 11,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  marginTop: 1,
                }}
              >
                {i + 1}
              </div>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#1E293B" }}>{a.title}</span>
                <span
                  style={{
                    fontSize: 12,
                    color: "#94A3B8",
                    display: "block",
                    marginTop: 2,
                    lineHeight: 1.5,
                    wordBreak: "break-word",
                  }}
                >
                  — {a.detail}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
