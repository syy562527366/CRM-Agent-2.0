"use client";

/**
 * 线索分析报告 —— 五张连续数据卡片。
 *
 * 与 `LeadAnalysisCard` 的区别：
 * - 那个是「快速看一眼」的单卡，数据由模型在正文里手写 JSON；
 * - 这个是完整分析报告，一次给齐五问答案，**顺序由前端固定**，模型无法打乱。
 *
 * 只负责渲染，不做任何计算。缺字段就退化成「—」，绝不猜。
 */

export interface ReportCompetitor {
  name: string;
  /** positive / neutral / negative / price_sensitive */
  attitude?: string;
  quote?: string;
  date?: string;
}

export interface ReportAction {
  title: string;
  detail?: string;
  when?: string;
}

export interface LeadReport {
  customer?: string;
  leadId?: string;
  assignee?: string;
  status?: string;
  /** high / medium / low */
  intent?: string;
  intentBasis?: string;
  product?: string;
  budget?: string;
  priceNote?: string;
  loss?: {
    category?: string;
    detail?: string;
    quote?: string;
    date?: string;
  };
  competitors?: ReportCompetitor[];
  actions?: ReportAction[];
}

/* ========== 配色（沿用全站语义色） ========== */

const INTENT: Record<string, { bg: string; dot: string; text: string; label: string }> = {
  high: { bg: "#FEF2F2", dot: "#EF4444", text: "#DC2626", label: "高" },
  medium: { bg: "#FFFBEB", dot: "#F59E0B", text: "#D97706", label: "中" },
  low: { bg: "#F8FAFC", dot: "#64748B", text: "#475569", label: "低" },
};

const ATTITUDE: Record<string, { bg: string; color: string; label: string }> = {
  positive: { bg: "#DCFCE7", color: "#16A34A", label: "正面" },
  neutral: { bg: "#F1F5F9", color: "#64748B", label: "中立" },
  negative: { bg: "#FEE2E2", color: "#DC2626", label: "负面" },
  price_sensitive: { bg: "#FEF3C7", color: "#D97706", label: "比价" },
};

const REASON: Record<string, { bg: string; color: string }> = {
  价格异议: { bg: "#FEE2E2", color: "#DC2626" },
  预算不足: { bg: "#FEF3C7", color: "#D97706" },
  选择了竞品: { bg: "#FEE2E2", color: "#DC2626" },
  需求不匹配: { bg: "#F1F5F9", color: "#64748B" },
  跟进不及时: { bg: "#FEF3C7", color: "#D97706" },
  决策链受阻: { bg: "#EDE9FE", color: "#6D28D9" },
  已成交: { bg: "#DCFCE7", color: "#16A34A" },
  无法判断: { bg: "#F1F5F9", color: "#64748B" },
  其他: { bg: "#F1F5F9", color: "#64748B" },
};

const MONO = '"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace';

/* ========== 通用外壳 ========== */

function Card({
  no,
  question,
  right,
  children,
}: {
  no: number;
  question: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid #E2E8F0",
        borderRadius: 12,
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
          padding: "9px 14px",
          borderBottom: "1px solid #EEF2F7",
          background: "#FCFDFE",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            borderRadius: 5,
            background: "#EEF2FF",
            color: "#4338CA",
            fontSize: 11,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {no}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "#334155", lineHeight: 1.4 }}>{question}</span>
        <div style={{ flex: 1 }} />
        {right}
      </div>
      <div style={{ padding: "12px 14px" }}>{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 500, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: "#1E293B", lineHeight: 1.5, wordBreak: "break-word" }}>
        {children}
      </div>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 12.5, color: "#94A3B8", fontWeight: 400 }}>{children}</span>;
}

function Chip({ bg, color, children }: { bg: string; color: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 9px",
        borderRadius: 999,
        background: bg,
        color,
        fontSize: 11.5,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

const dash = (v?: string) => (v && String(v).trim() ? v : "—");

/* ========== 卡片 1：客户与购买意向 ========== */

function CardIntent({ data }: { data: LeadReport }) {
  const key = INTENT[data.intent ?? ""] ? (data.intent as string) : "";
  const ic = key ? INTENT[key] : null;
  // 高=3 格 / 中=2 格 / 低=1 格，用点的数量表示强弱，比拉一条满宽进度条好读
  const filled = key === "high" ? 3 : key === "medium" ? 2 : key === "low" ? 1 : 0;

  return (
    <Card
      no={1}
      question="客户的名称与购买意向如何？（高/中/低）"
      right={
        ic ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              background: ic.bg,
              border: `1px solid ${ic.dot}33`,
              borderRadius: 6,
              padding: "3px 10px",
              flexShrink: 0,
            }}
          >
            <span style={{ display: "inline-flex", gap: 2.5 }}>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: i < filled ? ic.dot : "#CBD5E1",
                  }}
                />
              ))}
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: ic.text }}>意向 {ic.label}</span>
          </span>
        ) : (
          <Muted>意向未知</Muted>
        )
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            background: "linear-gradient(135deg, #2563EB, #7C3AED)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontSize: 14,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {String(data.customer ?? "?").charAt(0)}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", lineHeight: 1.35 }}>
            {dash(data.customer)}
          </div>
          <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 1 }}>
            {[data.leadId, data.assignee ? `负责人 ${data.assignee}` : "", data.status]
              .filter(Boolean)
              .join(" · ") || "—"}
          </div>
        </div>
      </div>

      {data.intentBasis && (
        <div style={{ marginTop: 11, fontSize: 12.5, color: "#64748B", lineHeight: 1.7 }}>{data.intentBasis}</div>
      )}
    </Card>
  );
}

/* ========== 卡片 2：意向产品与预算 ========== */

function CardProduct({ data }: { data: LeadReport }) {
  return (
    <Card no={2} question="客户感兴趣的产品是哪个？预算范围">
      <div style={{ display: "flex", gap: 14 }}>
        <div style={{ flex: 1.35, minWidth: 0 }}>
          <Field label="意向产品">{dash(data.product)}</Field>
        </div>
        <div
          style={{
            width: 1,
            background: "#F1F5F9",
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Field label="预算范围">{dash(data.budget)}</Field>
        </div>
      </div>
      {data.priceNote && (
        <div
          style={{
            marginTop: 11,
            padding: "7px 11px",
            background: "#F8FAFC",
            borderRadius: 8,
            fontSize: 11.5,
            color: "#64748B",
            lineHeight: 1.6,
          }}
        >
          {data.priceNote}
        </div>
      )}
    </Card>
  );
}

/* ========== 卡片 3：未成交原因 ========== */

function CardReason({ data }: { data: LeadReport }) {
  const loss = data.loss ?? {};
  const tone = REASON[loss.category ?? ""] ?? REASON["其他"];

  return (
    <Card
      no={3}
      question="交易没有达成的原因是什么？"
      right={loss.category ? <Chip bg={tone.bg} color={tone.color}>{loss.category}</Chip> : undefined}
    >
      {loss.detail ? (
        <div style={{ fontSize: 13.5, color: "#334155", lineHeight: 1.7 }}>{loss.detail}</div>
      ) : (
        <Muted>沟通记录不足，无法判断</Muted>
      )}

      {loss.quote && (
        <div
          style={{
            marginTop: 10,
            padding: "8px 12px",
            borderLeft: "3px solid #C7D2FE",
            background: "#F8FAFC",
            borderRadius: "0 8px 8px 0",
          }}
        >
          <div style={{ fontSize: 12.5, color: "#475569", lineHeight: 1.65, fontStyle: "italic" }}>
            「{loss.quote}」
          </div>
          {loss.date && (
            <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4, fontFamily: MONO }}>{loss.date}</div>
          )}
        </div>
      )}
    </Card>
  );
}

/* ========== 卡片 4：竞品提及 ========== */

function CardCompetitor({ data }: { data: LeadReport }) {
  const list = (data.competitors ?? []).filter((c) => c && c.name);

  return (
    <Card
      no={4}
      question="客户是否提到了某些竞品？"
      right={<Muted>{list.length ? `${list.length} 个` : "无"}</Muted>}
    >
      {list.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#CBD5E1", flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "#94A3B8" }}>沟通记录中未提及竞品</span>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {list.map((c, i) => {
            const a = ATTITUDE[c.attitude ?? ""] ?? ATTITUDE.neutral;
            return (
              <div
                key={`${c.name}-${i}`}
                style={{ display: "flex", alignItems: "flex-start", gap: 8, background: a.bg, borderRadius: 8, padding: "8px 11px" }}
              >
                <span style={{ fontSize: 13, fontWeight: 700, color: a.color, flexShrink: 0, lineHeight: 1.5 }}>
                  {c.name}
                </span>
                <Chip bg="rgba(255,255,255,0.72)" color={a.color}>
                  {a.label}
                </Chip>
                <div style={{ minWidth: 0, flex: 1 }}>
                  {c.quote && (
                    <div style={{ fontSize: 11.5, color: "#64748B", lineHeight: 1.6, wordBreak: "break-word" }}>
                      「{c.quote}」
                    </div>
                  )}
                  {c.date && (
                    <div style={{ fontSize: 10.5, color: "#94A3B8", marginTop: 2, fontFamily: MONO }}>{c.date}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* ========== 卡片 5：跟进建议 ========== */

function CardAction({ data }: { data: LeadReport }) {
  const list = (data.actions ?? []).filter((a) => a && a.title);

  return (
    <Card
      no={5}
      question="客户后续应该如何跟进？建议"
      right={<Muted>{list.length ? `${list.length} 条` : "暂无"}</Muted>}
    >
      {list.length === 0 ? (
        <Muted>暂无可执行的跟进动作</Muted>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map((a, i) => (
            <div key={`${a.title}-${i}`} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
              <div
                style={{
                  width: 19,
                  height: 19,
                  borderRadius: 5,
                  background: "#EEF2FF",
                  color: "#4338CA",
                  fontSize: 10.5,
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
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: "#1E293B", lineHeight: 1.5 }}>{a.title}</span>
                  {a.when && (
                    <span
                      style={{
                        fontSize: 10.5,
                        color: "#2563EB",
                        background: "#EFF6FF",
                        borderRadius: 4,
                        padding: "1px 6px",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {a.when}
                    </span>
                  )}
                </div>
                {a.detail && (
                  <div style={{ fontSize: 12, color: "#64748B", lineHeight: 1.65, marginTop: 2, wordBreak: "break-word" }}>
                    {a.detail}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ========== 出口：五张卡按固定顺序排列 ========== */

export default function LeadReportCards({ data }: { data: LeadReport }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9, maxWidth: "100%" }}>
      <CardIntent data={data} />
      <CardProduct data={data} />
      <CardReason data={data} />
      <CardCompetitor data={data} />
      <CardAction data={data} />
    </div>
  );
}
