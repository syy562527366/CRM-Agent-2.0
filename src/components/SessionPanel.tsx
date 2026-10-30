"use client";

import { useEffect, useRef, useState } from "react";

/* ========== 类型 ========== */

export interface SessionMeta {
  id: string;
  user_id?: string;
  title: string;
  created_at: string;
  updated_at: string;
  turns: number;
}

/* ========== 工具函数 ========== */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 会话时间：今天/昨天显示时分，更早显示日期 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ========== 图标 ========== */

function IconChevronLeft() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 5 8 12 15 19" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="14" height="14" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconTrash({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width={size} height={size} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.6-.7L3 21l1.8-5.2A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
    </svg>
  );
}

/* ========== 会话管理栏 ========== */

export default function SessionPanel({
  sessions,
  activeId,
  loading,
  loadingId,
  onNew,
  onSelect,
  onDelete,
  onCollapse,
}: {
  sessions: SessionMeta[];
  activeId: string;
  loading: boolean;
  loadingId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCollapse: () => void;
}) {
  // 删除二次确认：首次点击进入待确认态，3 秒内再点才真删
  const [armedId, setArmedId] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const armDelete = (id: string) => {
    if (armedId === id) {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      setArmedId(null);
      onDelete(id);
      return;
    }
    setArmedId(id);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setArmedId(null), 3000);
  };

  return (
    <aside
      style={{
        width: 262,
        flexShrink: 0,
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid #E2E8F0",
        background: "#FCFDFE",
      }}
    >
      {/* ===== 顶栏：标题 + 收起 ===== */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "20px 12px 12px 16px",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "#64748B",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
            }}
          >
            会话记录
          </span>
          {sessions.length > 0 && (
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                color: "#94A3B8",
                background: "#F1F5F9",
                borderRadius: 999,
                padding: "1px 6px",
                lineHeight: 1.5,
              }}
            >
              {sessions.length}
            </span>
          )}
        </div>

        <button
          onClick={onCollapse}
          title="收起会话栏"
          aria-label="收起会话栏"
          style={{
            width: 26,
            height: 26,
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid transparent",
            borderRadius: 7,
            background: "transparent",
            color: "#94A3B8",
            cursor: "pointer",
            transition: "all .13s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#F1F5F9";
            e.currentTarget.style.color = "#475569";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "#94A3B8";
          }}
        >
          <IconChevronLeft />
        </button>
      </div>

      {/* ===== 创建会话（置顶） ===== */}
      <div style={{ padding: "0 12px 12px", flexShrink: 0 }}>
        <button
          onClick={onNew}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: "9px 12px",
            borderRadius: 9,
            border: "1px solid #DBEAFE",
            background: "#EFF6FF",
            color: "#1D4ED8",
            fontSize: 12.5,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: "pointer",
            transition: "all .14s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#2563EB";
            e.currentTarget.style.borderColor = "#2563EB";
            e.currentTarget.style.color = "#fff";
            e.currentTarget.style.boxShadow = "0 4px 12px rgba(37,99,235,0.22)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "#EFF6FF";
            e.currentTarget.style.borderColor = "#DBEAFE";
            e.currentTarget.style.color = "#1D4ED8";
            e.currentTarget.style.boxShadow = "none";
          }}
        >
          <IconPlus />
          创建会话
        </button>
      </div>

      <div style={{ height: 1, background: "#F1F5F9", flexShrink: 0 }} />

      {/* ===== 历史会话列表（时间倒序） ===== */}
      <div
        className="session-scroll"
        style={{ flex: 1, overflowY: "auto", padding: "10px 10px 14px" }}
      >
        {loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  height: 44,
                  borderRadius: 9,
                  background: "linear-gradient(90deg,#F1F5F9 25%,#F8FAFC 37%,#F1F5F9 63%)",
                  backgroundSize: "400% 100%",
                  opacity: 1 - i * 0.25,
                }}
              />
            ))}
          </div>
        )}

        {!loading && sessions.length === 0 && (
          <div style={{ padding: "28px 10px", textAlign: "center" }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                background: "#F1F5F9",
                color: "#94A3B8",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 10px",
              }}
            >
              <IconChat />
            </div>
            <p style={{ fontSize: 12, color: "#94A3B8", margin: 0, lineHeight: 1.7 }}>
              还没有历史会话
              <br />
              发第一条消息即可保存
            </p>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {sessions.map((s) => {
            const isActive = s.id === activeId;
            const isBusy = loadingId === s.id;

            return (
              <div
                key={s.id}
                className={`session-item${isActive ? " is-active" : ""}`}
                onClick={() => {
                  if (!isActive) onSelect(s.id);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (!isActive) onSelect(s.id);
                  }
                }}
                style={{ cursor: isActive ? "default" : "pointer" }}
                title={s.title}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="session-title" style={{ fontWeight: isActive ? 600 : 500 }}>
                    {s.title || "新会话"}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      marginTop: 1,
                      fontSize: 10.5,
                      color: isActive ? "#60A5FA" : "#B0BAC9",
                    }}
                  >
                    {isBusy ? (
                      <span style={{ color: "#2563EB" }}>加载中…</span>
                    ) : (
                      <>
                        <span>{formatTime(s.updated_at)}</span>
                        {s.turns > 0 && <span>· {s.turns} 轮</span>}
                      </>
                    )}
                  </div>
                </div>

                <button
                  className={`session-del${armedId === s.id ? " is-armed" : ""}`}
                  title={armedId === s.id ? "再次点击确认删除" : "删除该会话"}
                  aria-label="删除该会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    armDelete(s.id);
                  }}
                >
                  <IconTrash />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* ===== 底部提示 ===== */}
      <div
        style={{
          flexShrink: 0,
          padding: "10px 16px 14px",
          borderTop: "1px solid #F1F5F9",
          fontSize: 10.5,
          color: "#B0BAC9",
          lineHeight: 1.6,
        }}
      >
        会话保存在本地 SQLite，重启不丢失
      </div>
    </aside>
  );
}
