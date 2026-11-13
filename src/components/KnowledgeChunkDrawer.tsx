"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * 知识库切片抽屉。
 *
 * 从右侧滑出，展示一篇文档切块后的真实文本——也就是送进 embedding 的原文。
 * 管理页只读不写：这里看到什么，Agent 检索到的就是什么，改内容必须重新上传。
 */

export interface ChunkDoc {
  doc_id: number;
  title: string;
  source: string;
  doc_type: string;
  chunks: number;
  chars: number;
  updated_at: string;
}

interface KbChunk {
  ord: number;
  heading: string;
  chars: number;
  content: string;
}

interface ChunkResponse {
  ok?: boolean;
  doc?: ChunkDoc;
  chunks?: KbChunk[];
  total?: number;
  truncated?: boolean;
  detail?: string;
}

const AGENT_BASE = "/agent-api";

function formatNumber(value: number): string {
  return (value ?? 0).toLocaleString("zh-CN");
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 命中的关键词高亮：先按小写定位，避免原文大小写差异 */
function Highlight({ text, keyword }: { text: string; keyword: string }) {
  const kw = keyword.trim();
  if (!kw) return <>{text}</>;

  const lowerText = text.toLowerCase();
  const lowerKw = kw.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let hit = lowerText.indexOf(lowerKw);

  while (hit !== -1) {
    if (hit > from) parts.push(text.slice(from, hit));
    parts.push(
      <mark key={`${hit}-${parts.length}`} style={{ background: "#FEF08A", color: "inherit", padding: "0 1px", borderRadius: 2 }}>
        {text.slice(hit, hit + kw.length)}
      </mark>,
    );
    from = hit + kw.length;
    hit = lowerText.indexOf(lowerKw, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

export default function KnowledgeChunkDrawer({
  doc,
  onClose,
}: {
  doc: ChunkDoc | null;
  onClose: () => void;
}) {
  const [chunks, setChunks] = useState<KbChunk[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [copied, setCopied] = useState<number | null>(null);

  const docId = doc?.doc_id ?? null;

  /* ---------- 拉取切片 ---------- */
  // 状态复位交给父级的 key（按 doc_id 重挂），effect 里只做请求：
  // 在 effect 体内同步 setState 会触发级联渲染，react-hooks 会直接报错。
  useEffect(() => {
    if (docId === null) return;
    let alive = true;

    (async () => {
      try {
        const res = await fetch(`${AGENT_BASE}/kb/documents/${docId}/chunks`, { cache: "no-store" });
        const data = (await res.json()) as ChunkResponse;
        if (!alive) return;
        if (!res.ok) {
          setError(data.detail ?? `读取失败（HTTP ${res.status}）`);
          return;
        }
        setChunks(data.chunks ?? []);
        setTotal(data.total ?? data.chunks?.length ?? 0);
        setTruncated(Boolean(data.truncated));
      } catch {
        if (alive) setError("读取切片失败，Agent 服务可能不可达");
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [docId]);

  /* ---------- 抽屉交互：Esc 关闭 + 锁滚动 ---------- */
  useEffect(() => {
    if (!doc) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [doc, onClose]);

  const copy = useCallback(async (chunk: KbChunk) => {
    try {
      const text = chunk.heading ? `${chunk.heading}\n\n${chunk.content}` : chunk.content;
      await navigator.clipboard.writeText(text);
      setCopied(chunk.ord);
      window.setTimeout(() => setCopied((cur) => (cur === chunk.ord ? null : cur)), 1600);
    } catch {
      /* 剪贴板不可用（非 https / 无权限）时静默失败，不影响查看 */
    }
  }, []);

  const visible = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return chunks;
    return chunks.filter(
      (c) => c.content.toLowerCase().includes(kw) || (c.heading ?? "").toLowerCase().includes(kw),
    );
  }, [chunks, keyword]);

  if (!doc) return null;

  const avg = total > 0 ? Math.round(doc.chars / total) : 0;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1200, display: "flex" }}>
      {/* 遮罩 */}
      <div
        className="kb-drawer-mask"
        onClick={onClose}
        style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,.34)" }}
      />

      {/* 面板 */}
      <div
        className="kb-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="知识库切片详情"
        style={{
          position: "relative",
          marginLeft: "auto",
          width: "min(620px, 94vw)",
          height: "100%",
          background: "#fff",
          boxShadow: "-12px 0 32px rgba(15,23,42,.16)",
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid #E2E8F0",
        }}
      >
        {/* 头部 */}
        <div style={{ padding: "18px 22px 14px", borderBottom: "1px solid #E2E8F0", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: "#2563EB", letterSpacing: "0.04em", marginBottom: 4 }}>
                切片详情
              </div>
              <h2
                style={{
                  fontSize: 17,
                  fontWeight: 700,
                  color: "#0F172A",
                  margin: 0,
                  lineHeight: 1.4,
                  wordBreak: "break-word",
                }}
              >
                {doc.title}
              </h2>
              <div
                style={{
                  fontSize: 11.5,
                  color: "#94A3B8",
                  marginTop: 4,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  wordBreak: "break-all",
                }}
              >
                {doc.source}
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="关闭"
              style={{
                width: 30,
                height: 30,
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                border: "1px solid #E2E8F0",
                borderRadius: 8,
                background: "#fff",
                color: "#64748B",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "#F1F5F9";
                (e.currentTarget as HTMLElement).style.color = "#0F172A";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "#fff";
                (e.currentTarget as HTMLElement).style.color = "#64748B";
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* 指标 */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 12 }}>
            {[
              { label: "切片", value: `${formatNumber(total)} 片` },
              { label: "总字数", value: formatNumber(doc.chars) },
              { label: "平均长度", value: `${formatNumber(avg)} 字/片` },
              { label: "更新", value: formatTime(doc.updated_at) },
            ].map((item) => (
              <div key={item.label} style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
                <span style={{ fontSize: 11.5, color: "#94A3B8" }}>{item.label}</span>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#334155",
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.value}
                </span>
              </div>
            ))}
          </div>

          {/* 检索框 */}
          <div style={{ position: "relative", marginTop: 12 }}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="#94A3B8"
              strokeWidth="2"
              width="14"
              height="14"
              style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="在这篇文档的切片里搜索…"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "7px 10px 7px 30px",
                border: "1px solid #E2E8F0",
                borderRadius: 8,
                fontSize: 12.5,
                fontFamily: "inherit",
                color: "#1E293B",
                outline: "none",
                background: "#fff",
              }}
            />
            {keyword.trim() && (
              <span
                style={{
                  position: "absolute",
                  right: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontSize: 11.5,
                  color: "#94A3B8",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {visible.length} / {chunks.length}
              </span>
            )}
          </div>
        </div>

        {/* 切片列表 */}
        <div
          className="kb-chunk-scroll"
          style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "#F8FAFC", padding: "14px 22px 24px" }}
        >
          {loading && (
            <div style={{ padding: "48px 0", textAlign: "center", color: "#94A3B8", fontSize: 13 }}>正在读取切片…</div>
          )}

          {!loading && error && (
            <div
              style={{
                padding: "12px 14px",
                borderRadius: 10,
                background: "#FEF2F2",
                border: "1px solid #FECACA",
                color: "#B91C1C",
                fontSize: 12.5,
                lineHeight: 1.7,
              }}
            >
              {error}
            </div>
          )}

          {!loading && !error && chunks.length === 0 && (
            <div style={{ padding: "48px 0", textAlign: "center", color: "#94A3B8", fontSize: 13 }}>
              这篇文档没有切片记录
            </div>
          )}

          {!loading && !error && chunks.length > 0 && visible.length === 0 && (
            <div style={{ padding: "48px 0", textAlign: "center", color: "#94A3B8", fontSize: 13 }}>
              没有包含「{keyword.trim()}」的切片
            </div>
          )}

          {!loading &&
            !error &&
            visible.map((chunk) => (
              <div
                key={chunk.ord}
                style={{
                  background: "#fff",
                  border: "1px solid #E2E8F0",
                  borderRadius: 10,
                  padding: "12px 14px",
                  marginBottom: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: "#2563EB",
                      background: "#EFF6FF",
                      border: "1px solid #BFDBFE",
                      borderRadius: 5,
                      padding: "1px 7px",
                      fontVariantNumeric: "tabular-nums",
                      flexShrink: 0,
                    }}
                  >
                    #{chunk.ord + 1}
                  </span>
                  {chunk.heading && (
                    <span
                      style={{
                        fontSize: 12,
                        color: "#475569",
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        minWidth: 0,
                        flex: 1,
                      }}
                      title={chunk.heading}
                    >
                      {chunk.heading}
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: 11,
                      color: "#94A3B8",
                      fontVariantNumeric: "tabular-nums",
                      whiteSpace: "nowrap",
                      marginLeft: "auto",
                      flexShrink: 0,
                    }}
                  >
                    {formatNumber(chunk.chars)} 字
                  </span>
                  <button
                    onClick={() => void copy(chunk)}
                    title="复制这段切片"
                    style={{
                      flexShrink: 0,
                      padding: "2px 7px",
                      border: "1px solid #E2E8F0",
                      borderRadius: 5,
                      background: "#fff",
                      color: copied === chunk.ord ? "#15803D" : "#64748B",
                      fontSize: 11,
                      fontFamily: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    {copied === chunk.ord ? "已复制" : "复制"}
                  </button>
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: "#1E293B",
                    lineHeight: 1.75,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  <Highlight text={chunk.content} keyword={keyword} />
                </div>
              </div>
            ))}

          {truncated && !loading && (
            <div style={{ fontSize: 11.5, color: "#B45309", marginTop: 4 }}>
              切片较多，仅显示前 {formatNumber(chunks.length)} 片（共 {formatNumber(total)} 片）
            </div>
          )}
        </div>

        {/* 底部说明 */}
        <div
          style={{
            flexShrink: 0,
            padding: "10px 22px",
            borderTop: "1px solid #E2E8F0",
            fontSize: 11.5,
            color: "#94A3B8",
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "#fff",
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="11" x2="12" y2="16" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          这里展示的是送进 Embedding 的切块原文，每片独立向量化；内容只读，修改请重新上传同名文件
        </div>
      </div>
    </div>
  );
}
