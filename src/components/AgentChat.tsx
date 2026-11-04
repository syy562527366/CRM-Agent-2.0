"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import Sidebar from "./Sidebar";
import SessionPanel, { type SessionMeta } from "./SessionPanel";
import { BotAvatar, CopyIcon, ThinkingDots, UserAvatar } from "./chat/Atoms";
import ToolPanel, { type ToolCallView } from "./chat/ToolPanel";
import MarkdownRenderer from "./chat/MarkdownRenderer";
import LeadAnalysisCard, { type LeadAnalysisData } from "./chat/LeadAnalysisCard";
import DataTableCard, { type DataTableCardData } from "./chat/DataTableCard";
import ApprovalCard, {
  type ApprovalDecision,
  type ApprovalPayload,
} from "./chat/ApprovalCard";

/* ========== 类型 ========== */

/** 工具调用（流式与历史消息共用；result 为空表示仍在执行） */
type ToolCall = ToolCallView;

/** 审批卡状态：payload 来自 approval_required 事件，resolved 由本地决策写入 */
interface ApprovalState {
  payload: ApprovalPayload;
  resolved?: "approved" | "rejected" | null;
}

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  tools: ToolCall[];
  /** 工具明细卡片（来自 tool_data 事件，不进模型上下文） */
  cards: DataTableCardData[];
  /** 待人工审批的修改操作 */
  approval?: ApprovalState;
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

/* SSE 事件（与 agent/app.py 的 /chat/stream、/chat/resume 对齐） */
interface StreamEvent {
  node?: string;
  type:
    | "token"
    | "ai"
    | "tool"
    | "human"
    | "system"
    | "error"
    | "session"
    | "warn"
    | "tool_data"
    /** 修改类工具被拦下，等人批 */
    | "approval_required"
    | "approval_resolved"
    /** 本轮暂停（不是结束，是等人批） */
    | "paused";
  content?: string;
  tool_calls?: { name: string; args: Record<string, unknown>; id?: string }[];
  tool_call_id?: string | null;
  session?: SessionMeta;
  /* tool_data：工具明细，直接渲染成表格，不进入 messages[].content */
  tool?: string;
  kind?: string;
  title?: string;
  columns?: (string | { key: string; label?: string; align?: "left" | "right" })[];
  rows?: Record<string, unknown>[];
  total?: number;
  tool_data?: DataTableCardData;
  /* approval_required */
  thread_id?: string;
  interrupt_id?: string;
  actions?: ApprovalPayload["actions"];
  mode?: string;
  /* approval_resolved */
  decisions?: ApprovalDecision[];
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

/**
 * 把 HTTP 状态翻成可执行的中文提示。
 *
 * 502/503 几乎只有一个原因：3200 的 Agent 进程没在跑（代理转发失败），
 * 所以文案直接给出启动命令，而不是让用户去猜「服务返回 502」是什么意思。
 */
function explainStatus(status: number): string {
  if (status === 502 || status === 503 || status === 504) {
    return (
      "Agent 服务没有响应（127.0.0.1:3200 未启动）。\n\n" +
      "在项目根目录双击 `start-all.cmd`，或手动执行：\n\n" +
      "```bash\ncd agent && ./.venv/Scripts/python.exe app.py\n```"
    );
  }
  if (status === 401) {
    return "登录状态已失效，请刷新页面重新登录 CRM 后再试。";
  }
  if (status === 403) {
    return "当前账号没有使用 AI 助手的权限，请联系管理员开通「AI 助手」页面权限。";
  }
  return `Agent 服务返回 ${status}，请查看 agent 终端日志排查。`;
}

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
    // 明细卡片不落库，历史会话只回放正文与工具轨迹
    cards: [],
    time: "",
  }));
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

  // 审批：payload + 它挂在哪个气泡上（resume 时要接着这条消息继续渲染）
  const [pendingApproval, setPendingApproval] = useState<{
    payload: ApprovalPayload;
    messageId: string;
  } | null>(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);

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

  /* ---------- 流式消费：/chat/stream 与 /chat/resume 共用 ---------- */
  /**
   * 边读 SSE 边把结果打到指定气泡上。
   *
   * `seed` 是这条气泡已有的内容（审批后恢复时带着之前的正文与工具轨迹继续），
   * 返回本轮最终正文与「是否停在审批上」。
   */
  const consumeStream = useCallback(
    async (
      res: Response,
      agentMsgId: string,
      seed: { content: string; tools: ToolCall[]; cards: DataTableCardData[] },
      last: { current: string },
    ): Promise<{ content: string; paused: boolean }> => {
      let content = seed.content;
      let tools = seed.tools;
      let cards = seed.cards;
      let paused = false;

      const reader = res.body!.getReader();
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
            last.current = content;
            patchMessage(agentMsgId, { content, tools: [...tools] });
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
            last.current = content;
            patchMessage(agentMsgId, { content, tools: [...tools] });
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
                i === realIdx
                  ? {
                      ...t,
                      result: event.content ?? "",
                      // 结果回来了，「待审批」这个中间态要撤掉；已拒绝的保留拒绝态
                      status: t.status === "pending_approval" ? undefined : t.status,
                    }
                  : t,
              );
              patchMessage(agentMsgId, { tools: [...tools] });
            }
          } else if (event.type === "tool_data") {
            // 工具明细：渲染成表格卡片。刻意不写进 content，
            // 这样后续轮次模型只看得到摘要，明细不会反复占用上下文。
            const payload: DataTableCardData | null =
              event.tool_data ??
              (event.columns?.length
                ? {
                    kind: event.kind,
                    title: event.title,
                    tool: event.tool,
                    columns: event.columns.map((c) => (typeof c === "string" ? { key: c } : c)),
                    rows: event.rows ?? [],
                    total: event.total,
                  }
                : null);
            if (payload && payload.columns.length) {
              cards = [...cards, payload];
              patchMessage(agentMsgId, { cards: [...cards] });
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
          } else if (event.type === "approval_required") {
            // 修改类工具被拦下：挂上审批卡，并把对应工具行标成「待审批」
            const approval: ApprovalPayload = {
              thread_id: event.thread_id ?? threadId,
              interrupt_id: event.interrupt_id ?? "",
              actions: event.actions ?? [],
              mode: event.mode,
            };
            const names = new Set(approval.actions.map((a) => a.tool));
            tools = tools.map((t) =>
              names.has(t.name) && (!t.status || t.status === "running")
                ? { ...t, status: "pending_approval" as const }
                : t,
            );
            last.current = content;
            patchMessage(agentMsgId, {
              content,
              tools: [...tools],
              approval: { payload: approval },
            });
            setPendingApproval({ payload: approval, messageId: agentMsgId });
          } else if (event.type === "paused") {
            // 不是结束，是等人批：气泡保持非 streaming，输入框由 pendingApproval 锁住
            paused = true;
          } else if (event.type === "error") {
            throw new Error(event.content || "Agent 执行出错");
          }
        }
      }

      return { content, paused };
    },
    [patchMessage, threadId],
  );

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
        cards: [],
        time: nowTime(),
      };
      const agentMsg: ChatMessage = {
        id: nextId(),
        role: "agent",
        content: "",
        tools: [],
        cards: [],
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
      const last = { current: "" };

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

        const { content, paused } = await consumeStream(
          res,
          agentMsg.id,
          { content: "", tools: [], cards: [] },
          last,
        );

        if (!content && !paused) {
          patchMessage(agentMsg.id, {
            content: "（Agent 没有返回文本内容，请换个说法再试一次）",
            error: true,
          });
        }
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === "AbortError";
        if (aborted) {
          patchMessage(agentMsg.id, {
            content: last.current || "（已停止生成）",
            error: !last.current,
          });
        } else {
          const detail = err instanceof Error ? err.message : String(err);
          // "服务返回 502" 这类原始状态码对用户没有意义，换成可执行的建议
          const status = Number(detail.match(/服务返回 (\d{3})/)?.[1] ?? 0);
          patchMessage(agentMsg.id, {
            content: status
              ? explainStatus(status)
              : `无法连接 Agent 服务：${detail}\n\n请确认服务已启动（127.0.0.1:3200）。`,
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
    [input, streaming, threadId, userId, patchMessage, refreshSessions, consumeStream],
  );

  /* ---------- 审批：批准 / 拒绝后继续同一轮 ---------- */
  const handleResume = useCallback(
    async (messageId: string, decisions: ApprovalDecision[]) => {
      if (!pendingApproval || pendingApproval.messageId !== messageId || approvalSubmitting) return;

      const { payload } = pendingApproval;
      const target = messages.find((m) => m.id === messageId);
      const overall: "approved" | "rejected" = decisions.every((d) => d.type === "approve")
        ? "approved"
        : "rejected";

      // 被拒绝的那几项，工具行直接标成「已拒绝」；批准的保持执行中
      const rejectedNames = new Set(
        payload.actions.filter((_a, i) => decisions[i]?.type === "reject").map((a) => a.tool),
      );
      const seededTools = (target?.tools ?? []).map((t) =>
        rejectedNames.has(t.name) && t.status === "pending_approval"
          ? { ...t, status: "rejected" as const }
          : t,
      );
      const seed = {
        content: target?.content ?? "",
        tools: seededTools,
        cards: target?.cards ?? [],
      };

      // 先落定卡片状态，避免重复点击
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                approval: { payload, resolved: overall },
                tools: seededTools,
                streaming: true,
              }
            : m,
        ),
      );
      setPendingApproval(null);
      setApprovalSubmitting(true);

      const controller = new AbortController();
      abortRef.current = controller;
      const last = { current: seed.content };
      // 决策是否已被服务端接收：接收后出错不应把卡片退回可点状态（否则会重复提交）
      let accepted = false;

      try {
        const res = await fetch(`${AGENT_BASE}/chat/resume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thread_id: threadId, decisions, user_id: userId }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`服务返回 ${res.status}`);
        }
        accepted = true;

        await consumeStream(res, messageId, seed, last);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const status = Number(detail.match(/服务返回 (\d{3})/)?.[1] ?? 0);
        patchMessage(messageId, {
          content:
            last.current ||
            (status
              ? explainStatus(status)
              : `审批提交失败：${detail}\n\n请确认 Agent 服务已启动（127.0.0.1:3200）。`),
          error: !last.current,
        });
        if (!accepted) {
          // 服务端没收到决策 → 退回可点状态，让用户重试
          setMessages((prev) =>
            prev.map((m) =>
              m.id === messageId
                ? { ...m, approval: { payload, resolved: null }, tools: target?.tools ?? [] }
                : m,
            ),
          );
          setPendingApproval({ payload, messageId });
        }
      } finally {
        patchMessage(messageId, { streaming: false });
        setApprovalSubmitting(false);
        abortRef.current = null;
        void refreshSessions();
      }
    },
    [
      pendingApproval,
      approvalSubmitting,
      messages,
      threadId,
      userId,
      patchMessage,
      consumeStream,
      refreshSessions,
    ],
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
    setPendingApproval(null);
    setApprovalSubmitting(false);
    setThreadId(newThreadId());
    pinnedRef.current = true;
    textareaRef.current?.focus();
  }, []);

  /* ---------- 切换会话（历史消息与实时消息共用同一套渲染） ---------- */
  const handleSelectSession = useCallback(async (id: string) => {
    abortRef.current?.abort();
    setStreaming(false);
    setInput("");
    setPendingApproval(null);
    setThreadId(id);
    setMessages([]);
    pinnedRef.current = true;

    const ticket = ++historySeqRef.current; // 防止快速切换时旧响应覆盖新会话
    setLoadingSessionId(id);
    setHistoryLoading(true);
    try {
      const res = await fetch(`${AGENT_BASE}/threads/${id}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`服务返回 ${res.status}`);
      const data = (await res.json()) as {
        messages?: HistoryMessage[];
        pending_approval?: ApprovalPayload | null;
      };
      if (ticket !== historySeqRef.current) return;

      const restored = toChatMessages(data.messages ?? []);
      const pending = data.pending_approval ?? null;
      if (pending && pending.actions?.length) {
        // 会话停在审批上：把卡片挂回最后一条 Agent 气泡，输入框继续保持锁定
        for (let i = restored.length - 1; i >= 0; i -= 1) {
          if (restored[i].role === "agent") {
            restored[i] = {
              ...restored[i],
              approval: { payload: pending },
              tools: restored[i].tools.map((t) =>
                t.result === undefined ? { ...t, status: "pending_approval" as const } : t,
              ),
            };
            setPendingApproval({ payload: pending, messageId: restored[i].id });
            break;
          }
        }
      }
      setMessages(restored);
    } catch (err) {
      if (ticket !== historySeqRef.current) return;
      const detail = err instanceof Error ? err.message : String(err);
      const status = Number(detail.match(/服务返回 (\d{3})/)?.[1] ?? 0);
      setMessages([
        {
          id: nextId(),
          role: "agent",
          content: status
            ? explainStatus(status)
            : `加载会话记录失败：${detail}\n\n请确认 Agent 服务已启动（127.0.0.1:3200）。`,
          tools: [],
          cards: [],
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
  // 有审批卡时锁住输入框：pending 状态下发新消息会被 LangGraph 拒绝
  const inputLocked = streaming || approvalSubmitting || Boolean(pendingApproval);

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
                  userInitial={(user?.name ?? "我").slice(0, 1)}
                  copied={copiedId === msg.id}
                  approvalSubmitting={approvalSubmitting}
                  onCopy={() => void handleCopy(msg)}
                  onApprovalResolve={(decisions) => void handleResume(msg.id, decisions)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ====== 输入区 ====== */}
        <div style={{ flexShrink: 0, borderTop: "1px solid #E2E8F0", background: "#fff", padding: "14px 32px 16px" }}>
          <div style={{ maxWidth: 860, margin: "0 auto" }}>
            <div
              className="chat-input-box"
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 10,
                borderRadius: 14,
                padding: "10px 10px 10px 14px",
                background: "#fff",
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
                disabled={inputLocked}
                placeholder={
                  pendingApproval
                    ? "请先处理上面的待审批操作（批准或拒绝）…"
                    : streaming
                      ? "正在生成回答…"
                      : "输入问题，Enter 发送，Shift + Enter 换行…"
                }
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
                  disabled={!input.trim() || inputLocked}
                  title={pendingApproval ? "请先处理待审批操作" : "发送（Enter）"}
                  style={{
                    width: 36,
                    height: 36,
                    flexShrink: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 10,
                    border: "none",
                    background: input.trim() && !inputLocked ? "#2563EB" : "#E2E8F0",
                    color: input.trim() && !inputLocked ? "#fff" : "#94A3B8",
                    cursor: input.trim() && !inputLocked ? "pointer" : "not-allowed",
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
      <div style={{ marginBottom: 18, borderRadius: 17, boxShadow: "0 10px 24px rgba(37,99,235,0.22)" }}>
        <BotAvatar size={54} />
      </div>

      <h2 style={{ fontSize: 18, fontWeight: 700, color: "#0F172A", margin: 0 }}>CRM 智能助手</h2>
      <p style={{ fontSize: 13, color: "#64748B", marginTop: 6, marginBottom: 16, textAlign: "center", lineHeight: 1.7 }}>
        基于 DeepAgents 的本地 Agent 服务
        {health ? ` · ${health.model}` : ""}
        <br />
        可以帮你分析线索、拆解任务、写邮件、做计算
      </p>

      {health && health.tools.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 6, marginBottom: 26 }}>
          {health.tools.map((t) => (
            <span
              key={t}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 9px",
                borderRadius: 999,
                border: "1px solid #E2E8F0",
                background: "#fff",
                fontSize: 11.5,
                fontWeight: 600,
                color: "#475569",
                fontFamily: '"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace',
              }}
            >
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#22C55E", flexShrink: 0 }} />
              {t}
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, width: "100%", maxWidth: 620 }}>
        {SUGGESTIONS.map((text) => (
          <button key={text} className="suggestion-card" onClick={() => onPick(text)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ========== 线索分析卡片围栏渲染 ========== */

function renderLeadCard(raw: string) {
  try {
    const data = JSON.parse(raw) as LeadAnalysisData;
    if (!data || typeof data !== "object" || !data.customer) return null;
    return <LeadAnalysisCard data={data} />;
  } catch {
    // 流式输出中 JSON 尚未闭合，交给渲染器显示占位动画
    return null;
  }
}

/* ========== 单条消息 ========== */

function MessageRow({
  msg,
  userInitial,
  copied,
  approvalSubmitting,
  onCopy,
  onApprovalResolve,
}: {
  msg: ChatMessage;
  userInitial: string;
  copied: boolean;
  approvalSubmitting?: boolean;
  onCopy: () => void;
  onApprovalResolve: (decisions: ApprovalDecision[]) => void;
}) {
  const isUser = msg.role === "user";
  const hasTools = !isUser && msg.tools.length > 0;
  const hasCards = !isUser && msg.cards.length > 0;
  const hasApproval = !isUser && Boolean(msg.approval);
  // 有工具在跑（或已带回明细卡片 / 审批卡）且还没正文时，只显示面板，不显示空气泡
  const showBubble =
    isUser || !!msg.content || (msg.streaming && !hasTools && !hasCards && !hasApproval);

  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        flexDirection: isUser ? "row-reverse" : "row",
        alignItems: "flex-start",
      }}
    >
      {isUser ? <UserAvatar initial={userInitial} size={30} /> : <BotAvatar size={32} />}

      <div
        style={{
          maxWidth: isUser ? "74%" : "84%",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: isUser ? "flex-end" : "flex-start",
        }}
      >
        {/* 工具调用轨迹（在气泡上方，按执行顺序展示） */}
        {hasTools && <ToolPanel tools={msg.tools} />}

        {/* 修改类操作的人工审批卡 */}
        {hasApproval && msg.approval && (
          <ApprovalCard
            data={msg.approval.payload}
            resolved={msg.approval.resolved}
            submitting={approvalSubmitting}
            onResolve={onApprovalResolve}
          />
        )}

        {/* 工具明细表格（来自 tool_data 事件） */}
        {hasCards &&
          msg.cards.map((card, index) => <DataTableCard key={`${msg.id}-card-${index}`} data={card} />)}

        {showBubble &&
          (isUser ? (
            <div
              style={{
                background: "#2563EB",
                color: "#fff",
                padding: "10px 15px",
                borderRadius: "14px 14px 4px 14px",
                fontSize: 14,
                lineHeight: 1.68,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                boxShadow: "0 2px 6px rgba(37,99,235,0.18)",
              }}
            >
              {msg.content}
            </div>
          ) : (
            <div
              style={{
                background: msg.error ? "#FFF5F5" : "#fff",
                border: `1px solid ${msg.error ? "#FECACA" : "#E2E8F0"}`,
                padding: "11px 15px",
                borderRadius: "4px 14px 14px 14px",
                minWidth: 56,
                maxWidth: "100%",
                overflow: "hidden",
                boxShadow: "0 1px 3px rgba(15,23,42,0.05)",
              }}
            >
              {msg.content ? (
                <>
                  <MarkdownRenderer content={msg.content} renderCodeBlock={renderLeadCard} />
                  {msg.streaming && <span className="chat-cursor" />}
                </>
              ) : (
                <ThinkingDots label="思考中…" />
              )}
            </div>
          ))}

        {/* 时间 / 复制 */}
        <div
          className="msg-meta"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 5,
            justifyContent: isUser ? "flex-end" : "flex-start",
            padding: "0 2px",
            minHeight: 16,
          }}
        >
          {msg.streaming ? (
            <span style={{ fontSize: 11, color: "#94A3B8" }}>正在生成…</span>
          ) : (
            msg.time && <span style={{ fontSize: 11, color: "#94A3B8" }}>{msg.time}</span>
          )}

          {!isUser && !msg.streaming && msg.content && (
            <button className="msg-action" onClick={onCopy} title="复制本条回答">
              <CopyIcon copied={copied} size={11} />
              {copied ? "已复制" : "复制"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
