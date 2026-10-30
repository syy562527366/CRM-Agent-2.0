"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAuth } from "@/context/AuthContext";
import Sidebar from "./Sidebar";
import SessionPanel, { type SessionMeta } from "./SessionPanel";

/* ========== 类型 ========== */

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  id?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  tools: ToolCall[];
  streaming?: boolean;
  error?: boolean;
  time: string;
}

/** 历史消息（服务端 /threads/{id} 返回，与流式消息结构对齐） */
interface HistoryMessage {
  role: "user" | "agent";
  content: string;
  tools?: { name: string; args?: Record<string, unknown>; result?: string | null }[];
}

interface HealthInfo {
  status: string;
  model: string;
  tools: string[];
}

/* SSE 事件（与 agent/app.py 的 /chat/stream 对齐） */
interface StreamEvent {
  node?: string;
  type: "token" | "ai" | "tool" | "human" | "system" | "error" | "session" | "warn";
  content?: string;
  tool_calls?: { name: string; args: Record<string, unknown>; id?: string }[];
  tool_call_id?: string | null;
  session?: SessionMeta;
}

/* ========== 常量 ========== */

const AGENT_BASE = "/agent-api";
const PANEL_KEY = "crm_agent_panel_open";

const SUGGESTIONS = [
  "帮我梳理本月新增线索的跟进优先级，并给出行动建议",
  "把本季度销售目标拆解成月度计划，用表格呈现",
  "写一封给客户的跟进邮件，语气专业但不生硬",
  "解释一下 CRM 里「数据范围：仅自己」和「全部」的区别",
];

/* ========== 工具函数 ========== */

function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `m${Date.now()}-${seq}`;
}

/** 新会话 ID：与服务端 `s-xxxx` 形式保持一致，首条消息落库时自动建档 */
function newThreadId(): string {
  const raw =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(16).slice(2).padEnd(12, "0");
  return `s-${raw.slice(0, 12)}`;
}

/** 历史消息 → 气泡消息（与实时流式共用同一份渲染数据） */
function toChatMessages(raw: HistoryMessage[]): ChatMessage[] {
  return raw.map((m, i) => ({
    id: `h${i}-${m.role}`,
    role: m.role,
    content: m.content ?? "",
    tools: (m.tools ?? []).map((t) => ({
      name: t.name,
      args: t.args ?? {},
      result: t.result ?? undefined,
    })),
    time: "",
  }));
}

/** 工具参数压成一行短文本，单参数直接取值 */
function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) return "";
  if (entries.length === 1) return String(entries[0][1]);
  return entries.map(([k, v]) => `${k}: ${v}`).join(", ");
}

/* ========== 图标 ========== */

function SparkIcon({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width={size} height={size}>
      <path d="M12 2.5l1.9 5.1 5.1 1.9-5.1 1.9L12 16.5l-1.9-5.1L5 9.5l5.1-1.9L12 2.5z" />
      <path d="M18.5 14.5l.95 2.55 2.55.95-2.55.95-.95 2.55-.95-2.55L15 18l2.55-.95.95-2.55z" opacity=".65" />
    </svg>
  );
}

/* ========== 主组件 ========== */

export default function AgentChat() {
  const { user } = useAuth();
  const userId = user?.id ?? "";

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [threadId, setThreadId] = useState(() => newThreadId());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 会话管理
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pinnedRef = useRef(true); // 是否停留在底部（决定是否自动滚动）
  const composingRef = useRef(false); // 中文输入法组合中
  const compositionEndAtRef = useRef(0); // 最近一次组合结束时间
  const historySeqRef = useRef(0); // 会话切换请求序号，丢弃过期响应

  /* ---------- 会话折叠状态 ---------- */
  useEffect(() => {
    // 放到下一帧再读，避免首屏同步 setState 造成二次渲染
    const timer = window.setTimeout(() => {
      if (localStorage.getItem(PANEL_KEY) === "0") setPanelOpen(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const setPanel = useCallback((open: boolean) => {
    setPanelOpen(open);
    try {
      localStorage.setItem(PANEL_KEY, open ? "1" : "0");
    } catch {
      /* 隐私模式下 localStorage 可能不可用 */
    }
  }, []);

  /* ---------- 会话列表 ---------- */
  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch(`${AGENT_BASE}/sessions?user_id=${encodeURIComponent(userId)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { sessions?: SessionMeta[] };
      setSessions(data.sessions ?? []);
    } catch {
      /* 服务未启动时静默，不影响对话 */
    } finally {
      setSessionsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    // 首屏拉取会话列表（异步，不产生同步级联渲染）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshSessions();
  }, [refreshSessions]);

  /* ---------- 服务状态 ---------- */
  useEffect(() => {
    let alive = true;
    fetch(`${AGENT_BASE}/health`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: HealthInfo) => {
        if (alive) setHealth(data);
      })
      .catch(() => {
        if (alive) setHealthError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  /* ---------- 自动滚动 ---------- */
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  /* ---------- 输入框高度自适应 ---------- */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  /* ---------- 消息更新助手 ---------- */
  const patchMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  /* ---------- 发送 ---------- */
  const handleSend = useCallback(
    async (raw?: string) => {
      const text = (raw ?? input).trim();
      if (!text || streaming) return;

      const userMsg: ChatMessage = {
        id: nextId(),
        role: "user",
        content: text,
        tools: [],
        time: nowTime(),
      };
      const agentMsg: ChatMessage = {
        id: nextId(),
        role: "agent",
        content: "",
        tools: [],
        streaming: true,
        time: nowTime(),
      };

      setMessages((prev) => [...prev, userMsg, agentMsg]);
      setInput("");
      setStreaming(true);
      pinnedRef.current = true;

      // 新会话先乐观插入列表，服务端会话索引返回后再校准
      setSessions((prev) => {
        if (prev.some((s) => s.id === threadId)) {
          return prev.map((s) =>
            s.id === threadId
              ? { ...s, updated_at: new Date().toISOString(), turns: s.turns + 1 }
              : s,
          );
        }
        const now = new Date().toISOString();
        return [
          {
            id: threadId,
            user_id: userId,
            title: text.replace(/\s+/g, " ").slice(0, 40),
            created_at: now,
            updated_at: now,
            turns: 1,
          },
          ...prev,
        ];
      });

      const controller = new AbortController();
      abortRef.current = controller;

      // 流式过程中累积状态（避免依赖 message 快照）
      let content = "";
      let tools: ToolCall[] = [];

      try {
        const res = await fetch(`${AGENT_BASE}/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, thread_id: threadId, user_id: userId }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`服务返回 ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";

          for (const block of blocks) {
            const line = block.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;

            let event: StreamEvent;
            try {
              event = JSON.parse(payload) as StreamEvent;
            } catch {
              continue;
            }

            if (event.type === "token") {
              // 逐 token 增量，打字机效果
              content += event.content ?? "";
              patchMessage(agentMsg.id, { content, tools: [...tools] });
            } else if (event.type === "ai") {
              if (event.tool_calls?.length) {
                tools = [
                  ...tools,
                  ...event.tool_calls.map((c) => ({ name: c.name, args: c.args ?? {}, id: c.id })),
                ];
                // 发起工具调用后属于新一轮回答，正文重新累积
                if (!event.content) content = "";
              }
              if (event.content) content = event.content;
              patchMessage(agentMsg.id, { content, tools: [...tools] });
            } else if (event.type === "tool") {
              // 工具结果按 tool_call_id 回填（并发工具返回顺序不定）
              let realIdx = event.tool_call_id
                ? tools.findIndex((t) => t.id === event.tool_call_id)
                : -1;
              if (realIdx === -1) {
                const pending = [...tools].reverse().findIndex((t) => t.result === undefined);
                if (pending !== -1) realIdx = tools.length - 1 - pending;
              }
              if (realIdx !== -1) {
                tools = tools.map((t, i) =>
                  i === realIdx ? { ...t, result: event.content ?? "" } : t,
                );
                patchMessage(agentMsg.id, { tools: [...tools] });
              }
            } else if (event.type === "session" && event.session) {
              // 服务端回传会话索引（标题 / 轮数 / 活跃时间），列表按时间倒序校准
              const incoming = event.session;
              setSessions((prev) => {
                const rest = prev.filter((s) => s.id !== incoming.id);
                return [incoming, ...rest].sort((a, b) =>
                  a.updated_at < b.updated_at ? 1 : -1,
                );
              });
            } else if (event.type === "error") {
              throw new Error(event.content || "Agent 执行出错");
            }
          }
        }

        if (!content) {
          patchMessage(agentMsg.id, {
            content: "（Agent 没有返回文本内容，请换个说法再试一次）",
            error: true,
          });
        }
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === "AbortError";
        if (aborted) {
          patchMessage(agentMsg.id, {
            content: content || "（已停止生成）",
            error: !content,
          });
        } else {
          const detail = err instanceof Error ? err.message : String(err);
          patchMessage(agentMsg.id, {
            content:
              `无法连接 Agent 服务：${detail}\n\n` +
              "请确认服务已启动：\n\n" +
              "```bash\ncd agent && ./.venv/Scripts/python.exe app.py\n```",
            error: true,
          });
        }
      } finally {
        patchMessage(agentMsg.id, { streaming: false });
        setStreaming(false);
        abortRef.current = null;
        void refreshSessions();
      }
    },
    [input, streaming, threadId, userId, patchMessage, refreshSessions],
  );

  /* ---------- 停止生成 ---------- */
  const handleStop = () => {
    abortRef.current?.abort();
  };

  /* ---------- 新建会话 ---------- */
  const handleNewSession = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStreaming(false);
    setInput("");
    setThreadId(newThreadId());
    pinnedRef.current = true;
    textareaRef.current?.focus();
  }, []);

  /* ---------- 切换会话（历史消息与实时消息共用同一套渲染） ---------- */
  const handleSelectSession = useCallback(async (id: string) => {
    abortRef.current?.abort();
    setStreaming(false);
    setInput("");
    setThreadId(id);
    setMessages([]);
    pinnedRef.current = true;

    const ticket = ++historySeqRef.current; // 防止快速切换时旧响应覆盖新会话
    setLoadingSessionId(id);
    setHistoryLoading(true);
    try {
      const res = await fetch(`${AGENT_BASE}/threads/${id}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`服务返回 ${res.status}`);
      const data = (await res.json()) as { messages?: HistoryMessage[] };
      if (ticket !== historySeqRef.current) return;
      setMessages(toChatMessages(data.messages ?? []));
    } catch (err) {
      if (ticket !== historySeqRef.current) return;
      const detail = err instanceof Error ? err.message : String(err);
      setMessages([
        {
          id: nextId(),
          role: "agent",
          content: `加载会话记录失败：${detail}\n\n请确认 Agent 服务已启动（127.0.0.1:3200）。`,
          tools: [],
          error: true,
          time: "",
        },
      ]);
    } finally {
      if (ticket === historySeqRef.current) {
        setHistoryLoading(false);
        setLoadingSessionId(null);
      }
    }
  }, []);

  /* ---------- 删除会话 ---------- */
  const handleDeleteSession = useCallback(
    async (id: string) => {
      setSessions((prev) => prev.filter((s) => s.id !== id));
      try {
        await fetch(`${AGENT_BASE}/sessions/${id}`, { method: "DELETE" });
      } catch {
        /* 服务不可用时仅本地移除，刷新后自然恢复 */
      }
      if (id === threadId) handleNewSession();
    },
    [threadId, handleNewSession],
  );

  /* ---------- 复制 ---------- */
  const handleCopy = async (msg: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopiedId(msg.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      /* 剪贴板不可用则静默失败 */
    }
  };

  /* ---------- 键盘：中文输入法回车不发送 ---------- */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter") return;

    // 1) 组合输入中（拼音候选未上屏）
    if (composingRef.current) return;
    // 2) 刚结束组合的 150ms 内，等输入法把事件处理完
    if (Date.now() - compositionEndAtRef.current < 150) return;
    // 3) 浏览器标记的输入法按键（部分 IME / Safari 不打 isComposing）
    const native = e.nativeEvent as KeyboardEvent;
    if (native.isComposing || native.keyCode === 229) return;
    // 4) Shift + Enter 换行
    if (e.shiftKey) return;

    e.preventDefault();
    void handleSend();
  };

  const isEmpty = messages.length === 0;
  const activeSession = sessions.find((s) => s.id === threadId) ?? null;
  const showEmpty = isEmpty && !historyLoading;

  /* ========== 渲染 ========== */
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar activeItem="agent" />

      {panelOpen && (
        <SessionPanel
          sessions={sessions}
          activeId={threadId}
          loading={sessionsLoading}
          loadingId={loadingSessionId}
          onNew={handleNewSession}
          onSelect={(id) => void handleSelectSession(id)}
          onDelete={(id) => void handleDeleteSession(id)}
          onCollapse={() => setPanel(false)}
        />
      )}

      <main
        style={{
          flex: 1,
          minWidth: 0,
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          background: "#fff",
        }}
      >
        {/* ====== 顶部标题栏 ====== */}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            padding: "18px 32px",
            borderBottom: "1px solid #E2E8F0",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            {!panelOpen && (
              <button
                onClick={() => setPanel(true)}
                title="展开会话栏"
                aria-label="展开会话栏"
                style={{
                  width: 32,
                  height: 32,
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid #E2E8F0",
                  borderRadius: 8,
                  background: "#fff",
                  color: "#475569",
                  cursor: "pointer",
                  transition: "all .13s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "#BFDBFE";
                  e.currentTarget.style.background = "#F8FBFF";
                  e.currentTarget.style.color = "#2563EB";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "#E2E8F0";
                  e.currentTarget.style.background = "#fff";
                  e.currentTarget.style.color = "#475569";
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2.5" />
                  <path d="M9 4v16" />
                  <polyline points="13.5 9.5 16.5 12 13.5 14.5" />
                </svg>
              </button>
            )}

            <div style={{ minWidth: 0 }}>
              <h1
              style={{
                fontSize: 20,
                fontWeight: 700,
                color: "#0F172A",
                letterSpacing: "-0.02em",
                margin: 0,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              AI 助手
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#2563EB",
                  background: "#EFF6FF",
                  border: "1px solid #DBEAFE",
                  borderRadius: 6,
                  padding: "1px 7px",
                  letterSpacing: 0,
                }}
              >
                DeepAgents
              </span>
            </h1>
            <p
              style={{
                fontSize: 12.5,
                color: "#64748B",
                margin: "3px 0 0",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 520,
              }}
            >
              {activeSession
                ? activeSession.title
                : "与本地 DeepAgent 服务对话，支持工具调用、Markdown 与多轮上下文"}
            </p>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {/* 服务状态 */}
            <div
              title={healthError ? "Agent 服务未连接（127.0.0.1:3200）" : "Agent 服务运行中"}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 10px",
                borderRadius: 8,
                border: "1px solid #E2E8F0",
                background: "#F8FAFC",
                fontSize: 12,
                fontWeight: 500,
                color: "#475569",
                whiteSpace: "nowrap",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: healthError ? "#EF4444" : health ? "#10B981" : "#CBD5E1",
                  flexShrink: 0,
                }}
              />
              {healthError ? "服务未连接" : health ? health.model : "连接中…"}
            </div>

            {!panelOpen && (
              <button
                onClick={handleNewSession}
                title="创建会话"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 12px",
                  borderRadius: 8,
                  border: "1px solid #DBEAFE",
                  background: "#EFF6FF",
                  color: "#1D4ED8",
                  fontSize: 12.5,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                创建会话
              </button>
            )}
          </div>
        </header>

        {/* ====== 对话区 ====== */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="chat-scroll"
          style={{
            flex: 1,
            overflowY: "auto",
            background: "#F8FAFC",
            padding: showEmpty ? 0 : "24px 32px 8px",
          }}
        >
          {historyLoading ? (
            <div
              style={{
                height: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span className="chat-dot" />
                <span className="chat-dot" />
                <span className="chat-dot" />
              </div>
              <span style={{ fontSize: 12.5, color: "#94A3B8" }}>正在加载会话记录…</span>
            </div>
          ) : showEmpty ? (
            <EmptyState onPick={(text) => void handleSend(text)} health={health} />
          ) : (
            <div style={{ maxWidth: 860, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
              {messages.map((msg) => (
                <MessageRow
                  key={msg.id}
                  msg={msg}
                  userName={user?.name ?? "我"}
                  copied={copiedId === msg.id}
                  onCopy={() => void handleCopy(msg)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ====== 输入区 ====== */}
        <div style={{ flexShrink: 0, borderTop: "1px solid #E2E8F0", background: "#fff", padding: "14px 32px 16px" }}>
          <div style={{ maxWidth: 860, margin: "0 auto" }}>
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 10,
                border: "1px solid #E2E8F0",
                borderRadius: 14,
                padding: "10px 10px 10px 14px",
                background: "#fff",
                boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
                transition: "border-color .15s ease, box-shadow .15s ease",
              }}
              onFocusCapture={(e) => {
                const el = e.currentTarget as HTMLElement;
                el.style.borderColor = "#BFDBFE";
                el.style.boxShadow = "0 0 0 3px rgba(37,99,235,0.08)";
              }}
              onBlurCapture={(e) => {
                const el = e.currentTarget as HTMLElement;
                el.style.borderColor = "#E2E8F0";
                el.style.boxShadow = "0 1px 2px rgba(15,23,42,0.04)";
              }}
            >
              <textarea
                ref={textareaRef}
                id="agent-input"
                name="message"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                  compositionEndAtRef.current = Date.now();
                }}
                rows={1}
                placeholder="输入问题，Enter 发送，Shift + Enter 换行…"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  outline: "none",
                  resize: "none",
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: "#1E293B",
                  fontFamily: "inherit",
                  background: "transparent",
                  padding: "6px 0",
                  maxHeight: 160,
                }}
              />

              {streaming ? (
                <button
                  onClick={handleStop}
                  title="停止生成"
                  style={{
                    width: 36,
                    height: 36,
                    flexShrink: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 10,
                    border: "1px solid #E2E8F0",
                    background: "#fff",
                    color: "#475569",
                    cursor: "pointer",
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={() => void handleSend()}
                  disabled={!input.trim()}
                  title="发送（Enter）"
                  style={{
                    width: 36,
                    height: 36,
                    flexShrink: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 10,
                    border: "none",
                    background: input.trim() ? "#2563EB" : "#E2E8F0",
                    color: input.trim() ? "#fff" : "#94A3B8",
                    cursor: input.trim() ? "pointer" : "not-allowed",
                    transition: "background .15s ease",
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" />
                  </svg>
                </button>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, padding: "0 2px" }}>
              <span style={{ fontSize: 11.5, color: "#94A3B8" }}>
                Enter 发送 · Shift + Enter 换行 · 中文输入法回车不会误发送
              </span>
              <span style={{ fontSize: 11.5, color: "#CBD5E1" }}>
                会话 ID · {threadId.slice(-6)}
              </span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

/* ========== 空状态 ========== */

function EmptyState({ onPick, health }: { onPick: (text: string) => void; health: HealthInfo | null }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 32px",
      }}
    >
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 16,
          background: "linear-gradient(135deg, #2563EB 0%, #60A5FA 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          boxShadow: "0 8px 20px rgba(37,99,235,0.24)",
          marginBottom: 18,
        }}
      >
        <SparkIcon size={24} />
      </div>

      <h2 style={{ fontSize: 18, fontWeight: 700, color: "#0F172A", margin: 0 }}>CRM 智能助手</h2>
      <p style={{ fontSize: 13, color: "#64748B", marginTop: 6, marginBottom: 26, textAlign: "center", lineHeight: 1.7 }}>
        基于 DeepAgents 的本地 Agent 服务
        {health ? ` · ${health.model} · ${health.tools.length} 个工具` : ""}
        <br />
        可以帮你分析线索、拆解任务、写邮件、做计算
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, width: "100%", maxWidth: 620 }}>
        {SUGGESTIONS.map((text) => (
          <button
            key={text}
            onClick={() => onPick(text)}
            style={{
              textAlign: "left",
              padding: "12px 14px",
              borderRadius: 10,
              border: "1px solid #E2E8F0",
              background: "#fff",
              color: "#334155",
              fontSize: 12.5,
              lineHeight: 1.6,
              fontFamily: "inherit",
              cursor: "pointer",
              transition: "all .15s ease",
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget;
              el.style.borderColor = "#BFDBFE";
              el.style.background = "#F8FBFF";
              el.style.color = "#1D4ED8";
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget;
              el.style.borderColor = "#E2E8F0";
              el.style.background = "#fff";
              el.style.color = "#334155";
            }}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ========== 单条消息 ========== */

function MessageRow({
  msg,
  userName,
  copied,
  onCopy,
}: {
  msg: ChatMessage;
  userName: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const isUser = msg.role === "user";

  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        flexDirection: isUser ? "row-reverse" : "row",
        alignItems: "flex-start",
      }}
    >
      {/* 头像 */}
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          fontWeight: 700,
          marginTop: 2,
          ...(isUser
            ? { background: "#DBEAFE", color: "#2563EB" }
            : {
                background: "linear-gradient(135deg, #2563EB 0%, #60A5FA 100%)",
                color: "#fff",
                boxShadow: "0 2px 6px rgba(37,99,235,0.25)",
              }),
        }}
      >
        {isUser ? userName.slice(0, 1) : <SparkIcon size={15} />}
      </div>

      {/* 气泡 */}
      <div style={{ maxWidth: isUser ? "72%" : "82%", minWidth: 0 }}>
        <div
          style={
            isUser
              ? {
                  background: "#2563EB",
                  color: "#fff",
                  padding: "10px 14px",
                  borderRadius: "12px 12px 3px 12px",
                  fontSize: 14,
                  lineHeight: 1.7,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  boxShadow: "0 1px 2px rgba(37,99,235,0.18)",
                }
              : {
                  background: msg.error ? "#FEF2F2" : "#fff",
                  border: `1px solid ${msg.error ? "#FECACA" : "#E2E8F0"}`,
                  padding: "12px 16px",
                  borderRadius: "12px 12px 12px 3px",
                  boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
                }
          }
        >
          {/* 工具调用轨迹 */}
          {!isUser && msg.tools.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: msg.content ? 10 : 0 }}>
              {msg.tools.map((tool, i) => (
                <span
                  key={`${tool.name}-${i}`}
                  title={tool.result ? `返回：${tool.result}` : "执行中…"}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "3px 9px",
                    borderRadius: 999,
                    border: "1px solid #E2E8F0",
                    background: "#F8FAFC",
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: "#475569",
                    maxWidth: "100%",
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2" width="11" height="11" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3l9.4-9.4z" />
                  </svg>
                  <span style={{ whiteSpace: "nowrap" }}>{tool.name}</span>
                  {formatArgs(tool.args) && (
                    <span
                      style={{
                        fontWeight: 400,
                        color: "#94A3B8",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: 180,
                      }}
                    >
                      {formatArgs(tool.args)}
                    </span>
                  )}
                  {tool.result !== undefined && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="3" width="11" height="11" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
              ))}
            </div>
          )}

          {/* 正文 */}
          {isUser ? (
            msg.content
          ) : msg.content ? (
            <div className="md-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
              {msg.streaming && <span className="chat-cursor" />}
            </div>
          ) : msg.streaming ? (
            <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 2px" }}>
              <span className="chat-dot" />
              <span className="chat-dot" />
              <span className="chat-dot" />
              <span style={{ fontSize: 12.5, color: "#94A3B8", marginLeft: 6 }}>思考中…</span>
            </div>
          ) : null}
        </div>

        {/* 时间 / 复制 */}
        <div
          className="group"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 4,
            justifyContent: isUser ? "flex-end" : "flex-start",
            padding: "0 2px",
          }}
        >
          {msg.time && <span style={{ fontSize: 11, color: "#CBD5E1" }}>{msg.time}</span>}
          {!isUser && !msg.streaming && msg.content && (
            <button
              onClick={onCopy}
              className="opacity-0 group-hover:opacity-100 transition-opacity"
              style={{
                border: "none",
                background: "transparent",
                color: copied ? "#10B981" : "#94A3B8",
                fontSize: 11,
                fontFamily: "inherit",
                cursor: "pointer",
                padding: 0,
              }}
            >
              {copied ? "已复制" : "复制"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
