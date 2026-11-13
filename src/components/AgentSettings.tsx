"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Sidebar from "./Sidebar";
import SkillManager from "./SkillManager";
import { useAuth } from "@/context/AuthContext";
import {
  canManageAgent,
  type AgentConfigView,
  type AgentHealth,
  type AgentToolRow,
  type MetricsOverview,
  type ModelProbe,
  type ToolPermission,
} from "@/types/agentConfig";
import {
  classifyAgentFailure,
  isOffline,
  type AgentFailure,
} from "@/lib/agent/errors";

/* ========== 常量 ========== */

const AGENT_BASE = "/agent-api";

const TABS = [
  { key: "overview", label: "Agent 概览" },
  { key: "prompt", label: "系统提示词" },
  { key: "tools", label: "工具与权限" },
  { key: "skills", label: "Skill 管理" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const CARD: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #E2E8F0",
  borderRadius: 12,
};

const PERMISSION_STYLE: Record<ToolPermission, { bg: string; color: string; border: string }> = {
  direct: { bg: "#F0FDF4", color: "#15803D", border: "#BBF7D0" },
  approval: { bg: "#FFF7ED", color: "#C2410C", border: "#FED7AA" },
  forbidden: { bg: "#FEF2F2", color: "#B91C1C", border: "#FECACA" },
};

/* ========== 格式化 ========== */

function formatNumber(value: number): string {
  return (value ?? 0).toLocaleString("zh-CN");
}

function formatTokens(value: number): string {
  const n = value ?? 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  return formatNumber(n);
}

function formatMs(value: number): string {
  const n = value ?? 0;
  if (!n) return "—";
  if (n < 1000) return `${n} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  const day = Math.floor(total / 86400);
  const hour = Math.floor((total % 86400) / 3600);
  const minute = Math.floor((total % 3600) / 60);
  if (day > 0) return `${day} 天 ${hour} 小时`;
  if (hour > 0) return `${hour} 小时 ${minute} 分`;
  return `${minute} 分钟`;
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function shortDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${month}/${date}`;
}

/** 某类工具重新打开时该用哪个权限：修改类回到「人工审批」，其余「直接使用」 */
function defaultPermission(tool: AgentToolRow): ToolPermission {
  return tool.category === "write" ? "approval" : "direct";
}

/* ========== 小组件 ========== */

function StatCard({
  label,
  value,
  hint,
  icon,
  accent = "#2563EB",
  extra,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon: React.ReactNode;
  accent?: string;
  extra?: React.ReactNode;
}) {
  return (
    <div style={{ ...CARD, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 10, minHeight: 158 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: `${accent}12`,
            color: accent,
            flexShrink: 0,
          }}
        >
          {icon}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "#64748B" }}>{label}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#0F172A", lineHeight: 1.2 }}>{value}</div>
      {hint && <div style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.5 }}>{hint}</div>}
      {extra}
    </div>
  );
}

function Switch({
  checked,
  disabled,
  onChange,
  title,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: 38,
        height: 22,
        borderRadius: 999,
        border: "none",
        padding: 2,
        cursor: disabled ? "not-allowed" : "pointer",
        background: disabled ? "#E2E8F0" : checked ? "#2563EB" : "#CBD5E1",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: checked ? "flex-end" : "flex-start",
        transition: "background .15s ease",
        opacity: disabled ? 0.6 : 1,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          display: "block",
          boxShadow: "0 1px 2px rgba(15,23,42,.2)",
        }}
      />
    </button>
  );
}

/**
 * 服务没起时的排障卡。
 *
 * 原来这里只有一行「配置读取失败（HTTP 502）」——用户看不出 502 是进程没开、
 * 还是自己点错了，也不知道下一步该做什么。这张卡把「结论 + 命令 + 重试」
 * 放在一起，照着做就能恢复。
 */
function ServiceDownCard({
  failure,
  retrying,
  onRetry,
}: {
  failure: AgentFailure;
  retrying: boolean;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyCommand = useCallback(async () => {
    if (!failure.command) return;
    try {
      await navigator.clipboard.writeText(failure.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // 非 https / 限制剪贴板的环境：让用户手动选中命令，不弹错误打断他
    }
  }, [failure.command]);

  return (
    <div
      style={{
        ...CARD,
        borderColor: "#FECACA",
        background: "#FFFBFB",
        padding: "18px 20px",
        marginBottom: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            background: "#FEE2E2",
            color: "#DC2626",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12.5" /><line x1="12" y1="16" x2="12" y2="16" />
          </svg>
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#991B1B" }}>{failure.title}</div>
          <div style={{ fontSize: 12.5, color: "#7F1D1D", marginTop: 4, lineHeight: 1.7 }}>
            {failure.detail}
          </div>
        </div>
      </div>

      {failure.command && (
        <div
          style={{
            marginTop: 12,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 12px",
            borderRadius: 9,
            background: "#0F172A",
          }}
        >
          <code
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12.5,
              color: "#E2E8F0",
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
              overflowX: "auto",
              whiteSpace: "nowrap",
            }}
          >
            {failure.command}
          </code>
          <button
            onClick={() => void copyCommand()}
            style={{
              flexShrink: 0,
              padding: "4px 10px",
              borderRadius: 6,
              border: "1px solid rgba(226,232,240,.25)",
              background: "transparent",
              color: copied ? "#4ADE80" : "#CBD5E1",
              fontSize: 11.5,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        <button
          onClick={onRetry}
          disabled={retrying}
          style={{
            padding: "7px 14px",
            borderRadius: 8,
            border: "none",
            background: retrying ? "#93C5FD" : "#2563EB",
            color: "#fff",
            fontSize: 12.5,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: retrying ? "wait" : "pointer",
          }}
        >
          {retrying ? "检测中…" : "重新检测"}
        </button>
        <span style={{ fontSize: 12, color: "#94A3B8" }}>
          服务起来后点「重新检测」即可，不用刷新页面
        </span>
      </div>
    </div>
  );
}

/* ========== 主体 ========== */
export default function AgentSettings() {
  const { role } = useAuth();
  const allowed = canManageAgent(role);

  const [tab, setTab] = useState<TabKey>("overview");
  const [loading, setLoading] = useState(true);
  // 失败原因用结构化对象保存：标题、说明、要执行的命令分开存，
  // 这样「服务没起」能渲染成排障卡，其它错误只当一行提示，不至于全糊成一串字
  const [failure, setFailure] = useState<AgentFailure | null>(null);

  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [healthError, setHealthError] = useState("");
  const [metrics, setMetrics] = useState<MetricsOverview | null>(null);
  const [config, setConfig] = useState<AgentConfigView | null>(null);

  const [probe, setProbe] = useState<ModelProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  // 草稿：只有点保存才会写回服务端，避免改一半就生效
  const [promptDraft, setPromptDraft] = useState("");
  const [toolDraft, setToolDraft] = useState<
    Record<string, { enabled: boolean; permission: ToolPermission }>
  >({});

  const applyConfig = useCallback((next: AgentConfigView) => {
    setConfig(next);
    setPromptDraft(next.system_prompt);
    setToolDraft(
      Object.fromEntries(
        next.tools.map((tool) => [
          tool.name,
          { enabled: tool.enabled, permission: tool.permission },
        ]),
      ),
    );
  }, []);

  const notify = useCallback((text: string, ok = true) => {
    setToast({ text, ok });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  /* ---------- 加载 ---------- */
  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);

    // 健康检查是公开接口：即使没有配置权限，也能看出服务是否活着
    try {
      const res = await fetch(`${AGENT_BASE}/health`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHealth((await res.json()) as AgentHealth);
      setHealthError("");
    } catch (err) {
      setHealth(null);
      // 代理层连不上 3200 时回 502；fetch 自己抛错也归到这里
      setHealthError("127.0.0.1:3200 没有响应");
      const status = Number((err instanceof Error ? err.message : "").match(/(\d{3})/)?.[1]);
      setFailure(classifyAgentFailure(Number.isFinite(status) && status ? status : undefined));
    }

    try {
      const [configRes, metricsRes] = await Promise.all([
        fetch(`${AGENT_BASE}/config`, { cache: "no-store" }),
        fetch(`${AGENT_BASE}/metrics/overview?days=7`, { cache: "no-store" }),
      ]);

      if (configRes.status === 403) {
        setFailure(
          classifyAgentFailure(403, "当前账号没有 Agent 配置权限，请用系统管理员账号登录。"),
        );
        setConfig(null);
      } else if (!configRes.ok) {
        setFailure(classifyAgentFailure(configRes.status));
        setConfig(null);
      } else {
        applyConfig((await configRes.json()) as AgentConfigView);
        setFailure(null);
      }

      if (metricsRes.ok) setMetrics((await metricsRes.json()) as MetricsOverview);
    } catch (err) {
      setFailure(classifyAgentFailure(undefined, err instanceof Error ? err.message : undefined));
    } finally {
      setLoading(false);
    }
  }, [applyConfig]);

  useEffect(() => {
    // 首屏拉取配置与指标（异步，不产生同步级联渲染）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (allowed) void load();
    else setLoading(false);
  }, [allowed, load]);

  /* ---------- 模型连通性 ---------- */
  const modelName = health?.model ?? "";
  const testModel = useCallback(async () => {
    setProbing(true);
    try {
      const res = await fetch(`${AGENT_BASE}/config/test-model`, { method: "POST" });
      const data = (await res.json()) as ModelProbe & { detail?: string };
      if (!res.ok) {
        setProbe({
          ok: false,
          model: data.model ?? modelName ?? "—",
          latency_ms: 0,
          // 502 之类统一走同一条判定，别在卡片里露出一句「HTTP 502」
          message: classifyAgentFailure(res.status, data.detail).title,
        });
      } else {
        setProbe(data);
      }
    } catch (err) {
      setProbe({
        ok: false,
        model: modelName || "—",
        latency_ms: 0,
        message: classifyAgentFailure(undefined, err instanceof Error ? err.message : undefined).title,
      });
    } finally {
      setProbing(false);
    }
  }, [modelName]);

  /* ---------- 保存 ---------- */
  const promptDirty = !!config && promptDraft !== config.system_prompt;
  const changedTools = useMemo(() => {
    if (!config) return [] as { name: string; enabled: boolean; permission: ToolPermission }[];
    return config.tools
      .map((tool) => {
        const draft = toolDraft[tool.name];
        if (!draft) return null;
        if (draft.enabled === tool.enabled && draft.permission === tool.permission) return null;
        return { name: tool.name, ...draft };
      })
      .filter((item): item is { name: string; enabled: boolean; permission: ToolPermission } =>
        item !== null,
      );
  }, [config, toolDraft]);

  const save = useCallback(
    async (payload: { system_prompt?: string; tools?: Record<string, unknown> }) => {
      setSaving(true);
      try {
        const res = await fetch(`${AGENT_BASE}/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          notify(data.detail ?? `保存失败（HTTP ${res.status}）`, false);
          return;
        }
        applyConfig(data as AgentConfigView);
        notify("已保存，下一次提问即按新配置执行");
        // 配置版本变了，健康卡片里的工具列表要跟着刷新
        void load();
      } catch (err) {
        notify(err instanceof Error ? err.message : "保存失败", false);
      } finally {
        setSaving(false);
      }
    },
    [applyConfig, load, notify],
  );

  const resetAll = useCallback(async () => {
    if (!window.confirm("恢复出厂配置？系统提示词与所有工具开关 / 权限都会回到默认值。")) return;
    setSaving(true);
    try {
      const res = await fetch(`${AGENT_BASE}/config/reset`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        notify(data.detail ?? "恢复失败", false);
        return;
      }
      applyConfig(data as AgentConfigView);
      notify("已恢复出厂配置");
      void load();
    } finally {
      setSaving(false);
    }
  }, [applyConfig, load, notify]);

  const patchTool = useCallback((tool: AgentToolRow, change: Partial<{ enabled: boolean; permission: ToolPermission }>) => {
    setToolDraft((prev) => {
      const current = prev[tool.name] ?? { enabled: tool.enabled, permission: tool.permission };
      const next = { ...current, ...change };
      // 选「禁止」等于关掉；重新打开时不能还挂着「禁止」，否则开关是开的却没生效
      if (next.permission === "forbidden") next.enabled = false;
      if (change.enabled === true && next.permission === "forbidden") {
        next.permission = defaultPermission(tool);
      }
      return { ...prev, [tool.name]: next };
    });
  }, []);

  /* ---------- 无权限 ---------- */
  if (!allowed) {
    return (
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar activeItem="agent-settings" />
        <main style={{ flex: 1, padding: "28px 32px" }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: "#0F172A", margin: 0 }}>Agent 控制面板</h1>
          <div style={{ ...CARD, marginTop: 20, padding: 28, maxWidth: 560 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#B91C1C", marginBottom: 8 }}>无访问权限</div>
            <p style={{ fontSize: 13, color: "#64748B", margin: 0, lineHeight: 1.7 }}>
              控制面板会修改 Agent 的行为边界，只对系统管理员开放。
              如需调整，请联系管理员账号（具备「账号管理 → 修改」权限）操作。
            </p>
          </div>
        </main>
      </div>
    );
  }

  const toolRows = config?.tools ?? [];
  const stats = config?.stats;
  // 服务不可达时指标一律显示「—」：这时候拿不到数据，显示 0 会被误读成「今天没人用」
  const offline = isOffline(failure);
  const today = metrics?.today;
  const yesterday = metrics?.yesterday;
  const callDelta = today && yesterday ? today.calls - yesterday.calls : 0;
  const toolDelta = today && yesterday ? today.tool_calls - yesterday.tool_calls : 0;

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar activeItem="agent-settings" />
      <main style={{ flex: 1, minWidth: 0, padding: "28px 32px", overflowY: "auto", height: "100vh" }}>
        {/* ====== 标题 ====== */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, gap: 16 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: "#0F172A", letterSpacing: "-0.02em", margin: 0 }}>
              Agent 控制面板
            </h1>
            <p style={{ fontSize: 13, color: "#64748B", marginTop: 4, margin: 0 }}>
              查看运行状态与调用指标，配置系统提示词、可用工具与工具权限，管理 Skill 开关与内容
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {config && (
              <span style={{ fontSize: 11.5, color: "#94A3B8", fontFamily: "ui-monospace, monospace" }}>
                配置版本 {config.revision}
              </span>
            )}
            <button
              onClick={() => void load()}
              disabled={loading}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 14px",
                borderRadius: 9,
                border: "1px solid #E2E8F0",
                background: "#fff",
                color: "#475569",
                fontSize: 13,
                fontWeight: 500,
                fontFamily: "inherit",
                cursor: loading ? "wait" : "pointer",
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 3 21 9 15 9" />
              </svg>
              刷新
            </button>
          </div>
        </div>

        {/* ====== 失败提示 ====== */}
        {/* 服务没起 → 整块排障卡；其它错误（权限 / 内部错）→ 一行红条就够了 */}
        {failure &&
          (isOffline(failure) ? (
            <ServiceDownCard failure={failure} retrying={loading} onRetry={() => void load()} />
          ) : (
            <div style={{ ...CARD, borderColor: "#FECACA", background: "#FEF2F2", padding: "12px 16px", marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#B91C1C" }}>{failure.title}</div>
              <div style={{ fontSize: 12.5, color: "#7F1D1D", marginTop: 3, lineHeight: 1.6 }}>
                {failure.detail}
              </div>
            </div>
          ))}
        {toast && (
          <div
            style={{
              ...CARD,
              borderColor: toast.ok ? "#BBF7D0" : "#FECACA",
              background: toast.ok ? "#F0FDF4" : "#FEF2F2",
              padding: "10px 16px",
              marginBottom: 16,
              fontSize: 13,
              color: toast.ok ? "#15803D" : "#B91C1C",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" strokeLinecap="round" strokeLinejoin="round">
              {toast.ok ? <polyline points="20 6 9 17 4 12" /> : <><circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12" y2="16" /></>}
            </svg>
            {toast.text}
          </div>
        )}

        {/* ====== 页签 ====== */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, borderBottom: "1px solid #E2E8F0", marginBottom: 20 }}>
          {TABS.map((item) => {
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                style={{
                  padding: "10px 16px",
                  border: "none",
                  background: "transparent",
                  borderBottom: active ? "2px solid #2563EB" : "2px solid transparent",
                  color: active ? "#2563EB" : "#64748B",
                  fontSize: 13.5,
                  fontWeight: active ? 600 : 500,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  marginBottom: -1,
                }}
              >
                {item.label}
                {item.key === "tools" && stats ? (
                  <span style={{ marginLeft: 6, fontSize: 11.5, color: active ? "#60A5FA" : "#94A3B8" }}>
                    {stats.enabled}/{stats.total}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {/* ================= 概览 ================= */}
        {tab === "overview" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
              <StatCard
                label="服务健康"
                accent={health ? "#16A34A" : "#DC2626"}
                icon={
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                  </svg>
                }
                value={
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: health ? "#16A34A" : "#DC2626", boxShadow: health ? "0 0 0 3px #DCFCE7" : "0 0 0 3px #FEE2E2" }} />
                    {health ? "运行中" : "不可达"}
                  </span>
                }
                hint={health ? `已运行 ${formatUptime(health.uptime_s)} · ${health.storage}` : healthError}
              />
              <StatCard
                label="模型连通性"
                accent="#7C3AED"
                icon={
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                  </svg>
                }
                value={
                  probe ? (
                    <span style={{ fontSize: 18, color: probe.ok ? "#15803D" : "#B91C1C" }}>
                      {probe.ok ? `正常 · ${formatMs(probe.latency_ms)}` : "失败"}
                    </span>
                  ) : (
                    <span style={{ fontSize: 16, color: "#94A3B8", fontWeight: 600 }}>未检测</span>
                  )
                }
                hint={
                  offline
                    ? healthError
                    : probe?.ok
                      ? `${probe.model} · 返回「${(probe.reply ?? "").trim() || "pong"}」 · ${formatTime(probe.checked_at ?? "")}`
                      : probe
                        ? probe.message
                        : `当前模型 ${health?.model ?? "—"}，点击下方按钮发一次最小请求`
                }
                extra={
                  <button
                    onClick={() => void testModel()}
                    disabled={probing}
                    style={{
                      alignSelf: "flex-start",
                      marginTop: 2,
                      padding: "6px 12px",
                      borderRadius: 7,
                      border: "1px solid #DDD6FE",
                      background: probing ? "#F5F3FF" : "#F5F3FF",
                      color: "#6D28D9",
                      fontSize: 12,
                      fontWeight: 600,
                      fontFamily: "inherit",
                      cursor: probing ? "wait" : "pointer",
                    }}
                  >
                    {probing ? "检测中…" : "测试连通性"}
                  </button>
                }
              />
              <StatCard
                label="今日调用次数"
                value={offline ? "—" : `${formatNumber(today?.calls ?? 0)} 次`}
                hint={
                  offline
                    ? healthError
                    : today && yesterday
                      ? `较昨日 ${callDelta >= 0 ? "+" : ""}${callDelta} 次 · 覆盖 ${today.threads} 个会话`
                      : "按 /chat 请求计数，含审批后的继续执行"
                }
                icon={
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                }
              />
              <StatCard
                label="平均响应耗时"
                accent="#0891B2"
                value={formatMs(today?.avg_ms ?? 0)}
                hint={`P95 ${formatMs(today?.p95_ms ?? 0)} · 含工具调用与审批等待`}
                icon={
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" />
                  </svg>
                }
              />
              <StatCard
                label="工具调用次数"
                accent="#EA580C"
                value={offline ? "—" : `${formatNumber(today?.tool_calls ?? 0)} 次`}
                hint={
                  offline
                    ? healthError
                    : today && yesterday
                      ? `较昨日 ${toolDelta >= 0 ? "+" : ""}${toolDelta} 次 · 今日失败 ${today.errors} 轮`
                      : "本轮实际发起的工具调用个数"
                }
                icon={
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.7 6.3a4 4 0 0 0 5 5L18 13l-3-3 1.7-3.7z" />
                    <path d="M13 14 4 23l-1-1 9-9" />
                  </svg>
                }
              />
              <StatCard
                label="Token 消耗量"
                accent="#DB2777"
                value={offline ? "—" : formatTokens(today?.total_tokens ?? 0)}
                hint={
                  offline
                    ? healthError
                    : `输入 ${formatTokens(today?.prompt_tokens ?? 0)} · 输出 ${formatTokens(today?.completion_tokens ?? 0)}`
                }
                icon={
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2 2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
                  </svg>
                }
              />
            </div>

            {/* 7 日趋势 */}
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: 14, marginTop: 14 }}>
              <div style={{ ...CARD, padding: "18px 20px" }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#0F172A" }}>近 7 日调用趋势</span>
                  <span style={{ fontSize: 12, color: "#94A3B8" }}>
                    合计 {offline ? "—" : formatNumber((metrics?.trend ?? []).reduce((sum, item) => sum + item.calls, 0))} 次
                  </span>
                </div>
                {(() => {
                  const trend = metrics?.trend ?? [];
                  const max = Math.max(1, ...trend.map((item) => item.calls));
                  return (
                    <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 150 }}>
                      {trend.map((item, index) => {
                        const height = Math.round((item.calls / max) * 118);
                        const isToday = index === trend.length - 1;
                        return (
                          <div key={item.day} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 6, height: "100%" }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: item.calls ? "#475569" : "#CBD5E1" }}>
                              {item.calls}
                            </span>
                            <div
                              title={`${item.day}：${item.calls} 次 / ${formatTokens(item.tokens)} tokens / 均 ${formatMs(item.avg_ms)}`}
                              style={{
                                width: "100%",
                                maxWidth: 46,
                                height: Math.max(item.calls ? 6 : 2, height),
                                borderRadius: "5px 5px 2px 2px",
                                background: isToday
                                  ? "linear-gradient(180deg, #3B82F6, #2563EB)"
                                  : item.calls
                                    ? "linear-gradient(180deg, #BFDBFE, #93C5FD)"
                                    : "#F1F5F9",
                              }}
                            />
                            <span style={{ fontSize: 11, color: isToday ? "#2563EB" : "#94A3B8", fontWeight: isToday ? 600 : 400 }}>
                              {shortDay(item.day)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              <div style={{ ...CARD, padding: "18px 20px" }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A", marginBottom: 4 }}>工具使用排行</div>
                <div style={{ fontSize: 12, color: "#94A3B8", marginBottom: 14 }}>近 7 日调用次数</div>
                {(() => {
                  const rows = metrics?.top_tools ?? [];
                  if (!rows.length) {
                    return (
                      <div style={{ fontSize: 12.5, color: "#94A3B8", padding: "18px 0" }}>
                        {offline ? "服务未启动，暂时读不到调用记录" : "还没有工具调用记录"}
                      </div>
                    );
                  }
                  const max = Math.max(1, ...rows.map((item) => item.count));
                  const labelOf = (name: string) => toolRows.find((tool) => tool.name === name)?.label ?? name;
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {rows.map((row) => (
                        <div key={row.name}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                            <span style={{ color: "#334155", fontWeight: 500 }}>{labelOf(row.name)}</span>
                            <span style={{ color: "#64748B" }}>{row.count} 次</span>
                          </div>
                          <div style={{ height: 6, borderRadius: 999, background: "#F1F5F9", overflow: "hidden" }}>
                            <div style={{ width: `${Math.round((row.count / max) * 100)}%`, height: "100%", borderRadius: 999, background: "linear-gradient(90deg, #60A5FA, #2563EB)" }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>

            <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 12, lineHeight: 1.7 }}>
              指标统计口径：一次对话请求计 1 次调用（审批后继续执行单独计 1 次）；耗时从请求进入算到流式结束；
              Token 取自模型的 usage 字段。数据保存在 <code style={{ fontFamily: "ui-monospace, monospace" }}>agent/data/agent.db</code>，
              最近一次调用 {formatTime(metrics?.last_call_at ?? "")}。
            </div>
          </div>
        )}

        {/* 配置没读到时不渲染编辑区：空白的提示词框会让人以为「提示词是空的」，
            然后照着改、保存，实际上什么都没写进去。Skill 管理不依赖 config（读的是技能目录），
            所以不受这个限制 */}
        {(tab === "prompt" || tab === "tools") && !config && !loading && (
          <div style={{ ...CARD, padding: 24, lineHeight: 1.8 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#B91C1C", marginBottom: 6 }}>
              配置未加载
            </div>
            <div style={{ fontSize: 13, color: "#64748B" }}>
              {failure
                ? `${failure.title}。${failure.detail}`
                : "暂时读不到 Agent 配置，点右上角「刷新」重试。"}
            </div>
          </div>
        )}

        {/* ================= 系统提示词 ================= */}
        {tab === "prompt" && config && (
          <div style={{ ...CARD, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A" }}>系统提示词</div>
                <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 3 }}>
                  决定 Agent 的角色、数据纪律与回答风格；保存后下一次提问生效，进行中的会话不受影响
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: config?.is_default_prompt ? "#94A3B8" : "#C2410C" }}>
                  {config?.is_default_prompt ? "出厂默认" : "已自定义"}
                </span>
                <button
                  onClick={() => setPromptDraft(config?.default_prompt ?? "")}
                  disabled={!config || promptDraft === config.default_prompt}
                  style={{
                    padding: "7px 12px",
                    borderRadius: 8,
                    border: "1px solid #E2E8F0",
                    background: "#fff",
                    color: "#475569",
                    fontSize: 12.5,
                    fontFamily: "inherit",
                    cursor: !config || promptDraft === config.default_prompt ? "not-allowed" : "pointer",
                    opacity: !config || promptDraft === config.default_prompt ? 0.5 : 1,
                  }}
                >
                  还原默认文案
                </button>
                <button
                  onClick={() => void save({ system_prompt: promptDraft })}
                  disabled={!promptDirty || saving}
                  style={{
                    padding: "7px 14px",
                    borderRadius: 8,
                    border: "none",
                    background: promptDirty && !saving ? "#2563EB" : "#E2E8F0",
                    color: promptDirty && !saving ? "#fff" : "#94A3B8",
                    fontSize: 12.5,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    cursor: promptDirty && !saving ? "pointer" : "not-allowed",
                  }}
                >
                  {saving ? "保存中…" : "保存提示词"}
                </button>
              </div>
            </div>

            <textarea
              value={promptDraft}
              onChange={(event) => setPromptDraft(event.target.value)}
              spellCheck={false}
              style={{
                width: "100%",
                minHeight: 460,
                padding: 16,
                borderRadius: 10,
                border: "1px solid #E2E8F0",
                background: "#FCFDFE",
                color: "#1E293B",
                fontSize: 12.8,
                lineHeight: 1.85,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
                resize: "vertical",
                outline: "none",
                boxSizing: "border-box",
              }}
            />

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, flexWrap: "wrap", gap: 8 }}>
              <span style={{ fontSize: 12, color: promptDraft.length < 20 ? "#B91C1C" : "#94A3B8" }}>
                {promptDraft.length} 字符{promptDraft.length < 20 ? "（至少 20 字符）" : ""}
                {config?.updated_at ? ` · 上次更新 ${formatTime(config.updated_at)}${config.updated_by ? ` by ${config.updated_by}` : ""}` : ""}
              </span>
              {promptDirty && <span style={{ fontSize: 12, color: "#C2410C" }}>有未保存的修改</span>}
            </div>

            <div style={{ marginTop: 16, padding: "12px 14px", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 9, fontSize: 12, color: "#64748B", lineHeight: 1.75 }}>
              <strong style={{ color: "#334155" }}>提示词之外还有代码级硬约束</strong>：删除类工具不注册给模型、
              关闭的工具模型看不到、权限设为「人工审批」的调用必须人工点批准、写操作仍会校验权限位与字段白名单。
              改提示词只会改变 Agent 的「说话方式与判断倾向」，改不动这些边界。
            </div>
          </div>
        )}

        {/* ================= 工具与权限 ================= */}
        {tab === "tools" && config && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
              {stats && (
                <>
                  <Chip label={`共 ${stats.total} 个工具`} color="#475569" bg="#F1F5F9" />
                  <Chip label={`已启用 ${stats.enabled}`} color="#15803D" bg="#F0FDF4" />
                  <Chip label={`直接使用 ${stats.direct}`} color="#1D4ED8" bg="#EFF6FF" />
                  <Chip label={`人工审批 ${stats.approval}`} color="#C2410C" bg="#FFF7ED" />
                  <Chip label={`禁止 ${stats.forbidden}`} color="#B91C1C" bg="#FEF2F2" />
                </>
              )}
              <span style={{ marginLeft: "auto", fontSize: 12, color: "#94A3B8" }}>
                关闭或禁止的工具不会注册给模型，模型连工具名都看不到
              </span>
            </div>

            <div style={{ ...CARD, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#F8FAFC" }}>
                    {["工具", "类别", "说明", "启用", "权限"].map((title) => (
                      <th
                        key={title}
                        style={{
                          padding: "10px 16px",
                          textAlign: "left",
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: "#64748B",
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                          whiteSpace: "nowrap",
                          borderBottom: "1px solid #E2E8F0",
                        }}
                      >
                        {title}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {toolRows.map((tool) => {
                    const draft = toolDraft[tool.name] ?? { enabled: tool.enabled, permission: tool.permission };
                    const style = PERMISSION_STYLE[draft.permission];
                    return (
                      <tr key={tool.name} style={{ borderBottom: "1px solid #F1F5F9", background: tool.locked ? "#FCFDFE" : "#fff" }}>
                        <td style={{ padding: "12px 16px", minWidth: 168 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: tool.locked ? "#94A3B8" : "#1E293B", display: "flex", alignItems: "center", gap: 6 }}>
                            {tool.label}
                            {tool.locked && (
                              <svg viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2" width="12" height="12" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
                              </svg>
                            )}
                          </div>
                          <div style={{ fontSize: 11.5, color: "#94A3B8", fontFamily: "ui-monospace, monospace", marginTop: 2 }}>
                            {tool.name}
                          </div>
                        </td>
                        <td style={{ padding: "12px 16px", whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              fontSize: 11.5,
                              fontWeight: 500,
                              padding: "3px 8px",
                              borderRadius: 6,
                              background:
                                tool.category === "write" ? "#FFF7ED" : tool.category === "delete" ? "#FEF2F2" : "#F1F5F9",
                              color:
                                tool.category === "write" ? "#C2410C" : tool.category === "delete" ? "#B91C1C" : "#475569",
                            }}
                          >
                            {tool.category_label}
                          </span>
                        </td>
                        <td style={{ padding: "12px 16px", fontSize: 12.5, color: "#64748B", maxWidth: 380 }}>
                          {tool.summary}
                          {tool.locked && tool.lock_reason && (
                            <div style={{ fontSize: 11.5, color: "#B91C1C", marginTop: 3 }}>{tool.lock_reason}</div>
                          )}
                        </td>
                        <td style={{ padding: "12px 16px", width: 90 }}>
                          <Switch
                            checked={draft.enabled}
                            disabled={tool.locked}
                            title={tool.locked ? tool.lock_reason : draft.enabled ? "点击停用" : "点击启用"}
                            onChange={(next) => patchTool(tool, { enabled: next })}
                          />
                        </td>
                        <td style={{ padding: "12px 16px", width: 150 }}>
                          <select
                            value={draft.permission}
                            disabled={tool.locked}
                            onChange={(event) => patchTool(tool, { permission: event.target.value as ToolPermission })}
                            style={{
                              width: "100%",
                              padding: "6px 26px 6px 10px",
                              borderRadius: 8,
                              border: `1px solid ${style.border}`,
                              background: style.bg,
                              color: style.color,
                              fontSize: 12.5,
                              fontWeight: 500,
                              fontFamily: "inherit",
                              appearance: "none",
                              cursor: tool.locked ? "not-allowed" : "pointer",
                              opacity: tool.locked ? 0.55 : 1,
                              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394A3B8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,
                              backgroundRepeat: "no-repeat",
                              backgroundPosition: "right 8px center",
                            }}
                          >
                            {(config?.permission_options ?? []).map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 保存栏 */}
            <div
              style={{
                ...CARD,
                marginTop: 14,
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                position: "sticky",
                bottom: 12,
                boxShadow: changedTools.length ? "0 6px 20px rgba(15,23,42,.08)" : "none",
              }}
            >
              <div style={{ fontSize: 12.5, color: changedTools.length ? "#C2410C" : "#94A3B8" }}>
                {changedTools.length
                  ? `${changedTools.length} 个工具已修改，保存后下一次提问生效`
                  : "调整开关或权限后记得保存"}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  onClick={() => void resetAll()}
                  disabled={saving}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: "1px solid #E2E8F0",
                    background: "#fff",
                    color: "#64748B",
                    fontSize: 12.5,
                    fontFamily: "inherit",
                    cursor: saving ? "not-allowed" : "pointer",
                  }}
                >
                  恢复出厂配置
                </button>
                <button
                  onClick={() =>
                    void save({
                      tools: Object.fromEntries(
                        changedTools.map((item) => [item.name, { enabled: item.enabled, permission: item.permission }]),
                      ),
                    })
                  }
                  disabled={!changedTools.length || saving}
                  style={{
                    padding: "8px 18px",
                    borderRadius: 8,
                    border: "none",
                    background: changedTools.length && !saving ? "#2563EB" : "#E2E8F0",
                    color: changedTools.length && !saving ? "#fff" : "#94A3B8",
                    fontSize: 12.5,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    cursor: changedTools.length && !saving ? "pointer" : "not-allowed",
                  }}
                >
                  {saving ? "保存中…" : "保存更改"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ================= Skill 管理 ================= */}
        {tab === "skills" && <SkillManager notify={notify} />}

        {loading && !config && tab !== "skills" && (
          <div style={{ padding: "40px 0", textAlign: "center", fontSize: 13, color: "#94A3B8" }}>加载中…</div>
        )}
      </main>
    </div>
  );
}

function Chip({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span style={{ fontSize: 12, fontWeight: 500, color, background: bg, padding: "4px 10px", borderRadius: 999 }}>
      {label}
    </span>
  );
}
