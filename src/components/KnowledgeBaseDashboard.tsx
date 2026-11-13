"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./Sidebar";
import Modal from "./Modal";
import KnowledgeChunkDrawer from "./KnowledgeChunkDrawer";
import { useAuth } from "@/context/AuthContext";
import { canManageAgent } from "@/types/agentConfig";

/**
 * Agent 知识库文件管理。
 *
 * 页面做四件事：看已挂载的文档、看某篇切分后的原文、删、上传。
 * 「不能改」是刻意的：改内容等于全篇重新向量化，让用户重新上传同名文件
 * （doc_key 相同会原地替换）比做一个半吊子编辑器可控得多。
 */

const AGENT_BASE = "/agent-api";
const MAX_MB = 20;
const ACCEPT = ".md,.markdown,.txt,.csv,.xlsx,.xlsm";

const CARD: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #E2E8F0",
  borderRadius: 12,
};

const TYPE_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  faq: { label: "产品FAQ", bg: "#EFF6FF", color: "#2563EB", border: "#BFDBFE" },
  product: { label: "产品信息", bg: "#ECFEFF", color: "#0E7490", border: "#A5F3FC" },
  skill: { label: "技能说明", bg: "#F5F3FF", color: "#7C3AED", border: "#DDD6FE" },
  doc: { label: "项目文档", bg: "#F8FAFC", color: "#475569", border: "#E2E8F0" },
  file: { label: "上传文件", bg: "#F0FDF4", color: "#15803D", border: "#BBF7D0" },
};

const STATUS_META: Record<string, { label: string; bg: string; color: string }> = {
  queued: { label: "排队中", bg: "#F1F5F9", color: "#475569" },
  parsing: { label: "解析文件", bg: "#EFF6FF", color: "#2563EB" },
  chunking: { label: "切块", bg: "#EFF6FF", color: "#2563EB" },
  embedding: { label: "向量化", bg: "#EFF6FF", color: "#2563EB" },
  indexing: { label: "写入索引", bg: "#EFF6FF", color: "#2563EB" },
  done: { label: "已入库", bg: "#F0FDF4", color: "#15803D" },
  failed: { label: "失败", bg: "#FEF2F2", color: "#B91C1C" },
};

interface KbDoc {
  doc_id: number;
  doc_key: string;
  title: string;
  source: string;
  doc_type: string;
  chunks: number;
  chars: number;
  created_at: string;
  updated_at: string;
}

interface KbStats {
  docs: number;
  chunks: number;
  vectors: number;
  chars: number;
  dim: number;
  model: string;
}

interface KbJob {
  job_id: string;
  filename: string;
  status: string;
  stage: string;
  progress: number;
  docs: number;
  chunks: number;
  chars: number;
  error: string;
  titles: string[];
  created_at: string;
  updated_at: string;
  finished_at: string;
}

interface OverviewResponse {
  ready: boolean;
  reason?: string;
  stats: KbStats | null;
  docs: KbDoc[];
  jobs: KbJob[];
  running: boolean;
}

/* ========== 工具函数 ========== */

function formatNumber(value: number): string {
  return (value ?? 0).toLocaleString("zh-CN");
}

/** UTC ISO → 本地 `MM-DD HH:mm`，列表里日期够用且不占宽 */
function formatTime(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatChars(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万字`;
  return `${formatNumber(n)} 字`;
}

/** ArrayBuffer → base64。分段转换，避免 `String.fromCharCode(...bytes)` 爆栈 */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 任务卡只留「正在跑的」和「3 分钟内结束的」。
 *
 * 任务记录在服务端是内存态历史，如果原样展示，用户删掉文档后卡片还挂在那，
 * 等于告诉人「刚入库成功」而列表里已经没有了 —— 看起来像删除没生效。
 * 结束已久的历史没有价值，直接不看。
 */
const JOB_KEEP_MS = 3 * 60 * 1000;

function isVisibleJob(job: KbJob): boolean {
  if (!["done", "failed"].includes(job.status)) return true;
  const ended = new Date(job.finished_at || job.updated_at).getTime();
  if (Number.isNaN(ended)) return true;
  return Date.now() - ended < JOB_KEEP_MS;
}

/* ========== 小组件 ========== */

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ ...CARD, padding: "14px 16px", flex: "1 1 0", minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#64748B", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 700, color: "#0F172A", lineHeight: 1.2 }}>{value}</div>
      {hint && (
        <div
          style={{
            fontSize: 11.5,
            color: "#94A3B8",
            marginTop: 4,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={hint}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

function TypeTag({ type }: { type: string }) {
  const meta = TYPE_META[type] ?? {
    label: type || "未知",
    bg: "#F8FAFC",
    color: "#475569",
    border: "#E2E8F0",
  };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 9px",
        borderRadius: 6,
        fontSize: 11.5,
        fontWeight: 600,
        background: meta.bg,
        color: meta.color,
        border: `1px solid ${meta.border}`,
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}

/** 单条上传任务卡：进度条 + 阶段文案 + 结果 */
function JobCard({ job }: { job: KbJob }) {
  const meta = STATUS_META[job.status] ?? STATUS_META.queued;
  const running = !["done", "failed"].includes(job.status);
  return (
    <div
      style={{
        ...CARD,
        padding: "12px 14px",
        borderColor: job.status === "failed" ? "#FECACA" : running ? "#BFDBFE" : "#E2E8F0",
        background: job.status === "failed" ? "#FFFBFB" : running ? "#F8FAFF" : "#fff",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: meta.bg,
            color: meta.color,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "#0F172A",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={job.filename}
          >
            {job.filename}
          </div>
          <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 2 }}>{job.stage}</div>
        </div>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: meta.color,
            background: meta.bg,
            borderRadius: 6,
            padding: "3px 9px",
            flexShrink: 0,
          }}
        >
          {meta.label}
        </span>
        <span style={{ fontSize: 11.5, color: "#94A3B8", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
          {job.progress}%
        </span>
      </div>

      <div style={{ height: 5, borderRadius: 999, background: "#E2E8F0", overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${Math.max(job.status === "failed" ? 100 : job.progress, 2)}%`,
            borderRadius: 999,
            background: job.status === "failed" ? "#DC2626" : job.status === "done" ? "#16A34A" : "#2563EB",
            transition: "width .4s ease",
          }}
        />
      </div>

      {job.status === "failed" ? (
        <div style={{ fontSize: 12, color: "#B91C1C", marginTop: 8, lineHeight: 1.6 }}>{job.error}</div>
      ) : (
        job.status === "done" && (
          <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 8 }}>
            {job.docs} 篇 / {job.chunks} 块 / {formatChars(job.chars)}
            {job.titles.length > 0 && `｜${job.titles.slice(0, 2).join("、")}${job.titles.length > 2 ? " 等" : ""}`}
          </div>
        )
      )}
    </div>
  );
}

/* ========== 主体 ========== */

export default function KnowledgeBaseDashboard() {
  const { role } = useAuth();
  const allowed = canManageAgent(role);

  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [stats, setStats] = useState<KbStats | null>(null);
  const [jobs, setJobs] = useState<KbJob[]>([]);
  const [ready, setReady] = useState(true);
  const [reason, setReason] = useState("");

  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [polling, setPolling] = useState(false);

  const [keyword, setKeyword] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  const [deleteTarget, setDeleteTarget] = useState<KbDoc | null>(null);
  const [chunkDoc, setChunkDoc] = useState<KbDoc | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);

  const notify = useCallback((text: string, ok = true) => {
    setToast({ text, ok });
    window.setTimeout(() => setToast(null), 3600);
  }, []);

  /* ---------- 数据加载 ---------- */
  // 只在「拉」的结尾关掉 loading，开头不置 true：
  // 首屏的 loading 由 state 初值 true 承担，刷新按钮自己置位。
  // 这样 effect 里调用 load 不会同步触发 setState（会引发级联渲染）。
  const load = useCallback(async () => {
    try {
      const res = await fetch(`${AGENT_BASE}/kb/documents`, { cache: "no-store" });
      const data = (await res.json()) as OverviewResponse & { detail?: string };
      if (!res.ok) {
        setReady(false);
        setReason(data.detail ?? `读取失败（HTTP ${res.status}）`);
        return;
      }
      setReady(data.ready);
      setReason(data.reason ?? "");
      setStats(data.stats);
      setDocs(data.docs ?? []);
      setJobs((data.jobs ?? []).filter(isVisibleJob));
      if (data.running) setPolling(true);
    } catch {
      setReady(false);
      setReason("Agent 服务未启动或不可达（默认 127.0.0.1:3200）");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  /* ---------- 进度轮询 ---------- */
  useEffect(() => {
    if (!polling) return;
    let alive = true;

    const tick = async () => {
      try {
        const res = await fetch(`${AGENT_BASE}/kb/jobs`, { cache: "no-store" });
        const data = (await res.json()) as { jobs?: KbJob[]; running?: boolean };
        if (!alive) return;
        setJobs((data.jobs ?? []).filter(isVisibleJob));
        if (!data.running) {
          setPolling(false);
          setUploading(false);
          void load();
        }
      } catch {
        if (alive) setPolling(false);
      }
    };

    const timer = window.setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [polling, load]);

  /* ---------- 上传 ---------- */
  const pickFile = () => {
    if (uploading) return;
    fileInput.current?.click();
  };

  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_MB * 1024 * 1024) {
        notify(`文件超过 ${MAX_MB} MB 上限，请拆分后再上传`, false);
        return;
      }
      setUploading(true);
      try {
        const buffer = await file.arrayBuffer();
        const res = await fetch(`${AGENT_BASE}/kb/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, content_base64: toBase64(buffer) }),
        });
        const data = (await res.json()) as { job?: KbJob; detail?: string };
        if (!res.ok || !data.job) {
          notify(data.detail ?? `上传失败（HTTP ${res.status}）`, false);
          setUploading(false);
          return;
        }
        setJobs((prev) => [data.job as KbJob, ...prev.filter((j) => j.job_id !== data.job?.job_id)]);
        setPolling(true);
        notify(`已提交「${data.job.filename}」，正在处理`);
      } catch (err) {
        notify(err instanceof Error ? err.message : "上传失败", false);
        setUploading(false);
      }
    },
    [notify],
  );

  /* ---------- 删除 ---------- */
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`${AGENT_BASE}/kb/documents/${deleteTarget.doc_id}`, { method: "DELETE" });
      const data = (await res.json()) as { detail?: string };
      if (!res.ok) {
        notify(data.detail ?? `删除失败（HTTP ${res.status}）`, false);
        return;
      }
      setDocs((prev) => prev.filter((doc) => doc.doc_id !== deleteTarget.doc_id));
      // 同步摘掉这篇文档对应的任务卡：文档都没了，还显示「已入库」会让人以为没删掉
      setJobs((prev) =>
        prev.filter((job) => !job.titles.includes(deleteTarget.title) && !job.filename.startsWith(deleteTarget.title)),
      );
      setDeleteTarget(null);
      if (chunkDoc?.doc_id === deleteTarget.doc_id) setChunkDoc(null);
      notify(`已删除「${deleteTarget.title}」，检索不再返回该文档`);
      void load();
    } catch (err) {
      notify(err instanceof Error ? err.message : "删除失败", false);
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, chunkDoc, load, notify]);

  /* ---------- 列表筛选 ---------- */
  const visible = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return docs.filter((doc) => {
      if (typeFilter !== "all" && doc.doc_type !== typeFilter) return false;
      if (!kw) return true;
      return (
        doc.title.toLowerCase().includes(kw) ||
        doc.source.toLowerCase().includes(kw) ||
        doc.doc_key.toLowerCase().includes(kw)
      );
    });
  }, [docs, keyword, typeFilter]);

  const typeOptions = useMemo(() => {
    const seen = new Set(docs.map((d) => d.doc_type));
    return Array.from(seen);
  }, [docs]);

  /* ---------- 无权限 ---------- */
  if (!allowed) {
    return (
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar activeItem="agent-kb" />
        <main style={{ flex: 1, padding: "28px 32px" }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: "#0F172A", margin: 0 }}>知识库管理</h1>
          <div style={{ ...CARD, marginTop: 20, padding: 28, maxWidth: 560 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#B91C1C", marginBottom: 8 }}>无访问权限</div>
            <p style={{ fontSize: 13, color: "#64748B", margin: 0, lineHeight: 1.7 }}>
              知识库是 Agent 回答产品资料的唯一事实来源，增删会直接影响所有账号的回答内容，
              因此只对系统管理员开放（需具备「账号管理 → 修改」权限）。
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar activeItem="agent-kb" />
      <main style={{ flex: 1, minWidth: 0, padding: "28px 32px", overflowY: "auto", height: "100vh" }}>
        {/* ====== 标题 ====== */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            marginBottom: 18,
          }}
        >
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: "#0F172A", letterSpacing: "-0.02em", margin: 0 }}>
              知识库管理
            </h1>
            <p style={{ fontSize: 13, color: "#64748B", margin: "4px 0 0" }}>
              管理 Agent 可检索的知识库文件。上传后自动完成切块、向量化并挂载到检索能力
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={() => {
                setLoading(true);
                void load();
              }}
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
                <path d="M21 12a9 9 0 1 1-3-6.7" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
              刷新
            </button>
            <button
              onClick={pickFile}
              disabled={uploading}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "9px 16px",
                borderRadius: 9,
                border: "none",
                background: uploading ? "#93C5FD" : "#2563EB",
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: uploading ? "wait" : "pointer",
                boxShadow: "0 1px 2px rgba(37,99,235,.25)",
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              {uploading ? "处理中…" : "上传"}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ""; // 允许连续上传同一个文件
                if (file) void handleFile(file);
              }}
            />
          </div>
        </div>

        {/* ====== 提示 ====== */}
        {toast && (
          <div
            style={{
              ...CARD,
              borderColor: toast.ok ? "#BBF7D0" : "#FECACA",
              background: toast.ok ? "#F0FDF4" : "#FEF2F2",
              padding: "10px 16px",
              marginBottom: 14,
              fontSize: 13,
              color: toast.ok ? "#15803D" : "#B91C1C",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" strokeLinecap="round" strokeLinejoin="round">
              {toast.ok ? <polyline points="20 6 9 17 4 12" /> : <><circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>}
            </svg>
            {toast.text}
          </div>
        )}

        {!ready && (
          <div style={{ ...CARD, borderColor: "#FECACA", background: "#FFFBFB", padding: "14px 18px", marginBottom: 14 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "#991B1B", marginBottom: 4 }}>知识库暂不可用</div>
            <div style={{ fontSize: 12.5, color: "#7F1D1D", lineHeight: 1.7 }}>{reason}</div>
            <code
              style={{
                display: "block",
                marginTop: 10,
                padding: "8px 10px",
                borderRadius: 8,
                background: "#0F172A",
                color: "#E2E8F0",
                fontSize: 12,
                overflowX: "auto",
              }}
            >
              cd agent && .venv\Scripts\python.exe -m kb.cli init
            </code>
          </div>
        )}

        {/* ====== 概览 ====== */}
        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          <StatCard label="已挂载文档" value={stats ? formatNumber(stats.docs) : "—"} hint="含内置 FAQ / 技能 / 上传文件" />
          <StatCard label="切片总数" value={stats ? formatNumber(stats.chunks) : "—"} hint="每片独立向量化" />
          <StatCard label="向量条数" value={stats ? formatNumber(stats.vectors) : "—"} hint="sqlite-vec KNN 索引" />
          <StatCard
            label="Embedding 模型"
            value={stats ? `${stats.dim} 维` : "—"}
            hint={stats?.model ?? ""}
          />
        </div>

        {/* ====== 处理中 / 最近任务 ====== */}
        {jobs.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
            {jobs.slice(0, 4).map((job) => (
              <JobCard key={job.job_id} job={job} />
            ))}
          </div>
        )}

        {/* ====== 文档列表 ====== */}
        <div style={CARD}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 20px",
              borderBottom: "1px solid #E2E8F0",
              flexWrap: "wrap",
            }}
          >
            <div style={{ position: "relative", flex: "1 1 220px", minWidth: 180 }}>
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
                placeholder="搜索文档标题 / 文件名"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "7px 10px 7px 30px",
                  border: "1px solid #E2E8F0",
                  borderRadius: 8,
                  fontSize: 13,
                  fontFamily: "inherit",
                  color: "#1E293B",
                  outline: "none",
                  background: "#fff",
                }}
              />
            </div>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              style={{
                padding: "7px 10px",
                border: "1px solid #E2E8F0",
                borderRadius: 8,
                fontSize: 13,
                fontFamily: "inherit",
                color: "#1E293B",
                background: "#fff",
                outline: "none",
                cursor: "pointer",
              }}
            >
              <option value="all">全部类型</option>
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {TYPE_META[t]?.label ?? t}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 12.5, color: "#94A3B8", marginLeft: "auto" }}>
              共 {visible.length} 篇
            </span>
          </div>

          {visible.length === 0 ? (
            <div style={{ padding: "56px 20px", textAlign: "center", color: "#94A3B8", fontSize: 13 }}>
              {docs.length === 0 ? "还没有挂载任何文档，点右上角「上传」开始" : "没有匹配的文档"}
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#FAFBFC", borderBottom: "1px solid #E2E8F0" }}>
                    {["文档名称", "类型", "切片数", "字数", "更新时间", "操作"].map((h, i) => (
                      <th
                        key={h}
                        style={{
                          padding: "10px 16px",
                          paddingLeft: i === 0 ? 20 : 16,
                          textAlign: i === 0 || i === 1 ? "left" : i === 5 ? "right" : "left",
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: "#64748B",
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((doc) => (
                    <tr
                      key={doc.doc_id}
                      style={{ borderBottom: "1px solid #F1F5F9" }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background = "#FAFBFC";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.background = "";
                      }}
                    >
                      <td style={{ padding: "12px 16px", paddingLeft: 20, maxWidth: 420 }}>
                        <div
                          style={{
                            fontWeight: 600,
                            color: "#1E293B",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={doc.title}
                        >
                          {doc.title}
                        </div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "#94A3B8",
                            marginTop: 2,
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={doc.source}
                        >
                          {doc.source}
                        </div>
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <TypeTag type={doc.doc_type} />
                      </td>
                      <td style={{ padding: "10px 16px" }}>
                        {/* 点数字看切分后的原文：这里是唯一能验证「切得好不好」的入口 */}
                        <button
                          onClick={() => setChunkDoc(doc)}
                          title="查看切片后的文本"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "3px 9px",
                            border: "1px solid #BFDBFE",
                            borderRadius: 6,
                            background: "#F8FAFF",
                            color: "#2563EB",
                            fontSize: 12.5,
                            fontWeight: 600,
                            fontFamily: "inherit",
                            fontVariantNumeric: "tabular-nums",
                            cursor: "pointer",
                            lineHeight: 1.5,
                          }}
                          onMouseEnter={(e) => {
                            (e.currentTarget as HTMLElement).style.background = "#EFF6FF";
                            (e.currentTarget as HTMLElement).style.borderColor = "#93C5FD";
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLElement).style.background = "#F8FAFF";
                            (e.currentTarget as HTMLElement).style.borderColor = "#BFDBFE";
                          }}
                        >
                          {formatNumber(doc.chunks)}
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            width="12"
                            height="12"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{ opacity: 0.85 }}
                          >
                            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        </button>
                      </td>
                      <td style={{ padding: "12px 16px", color: "#475569", whiteSpace: "nowrap" }}>
                        {formatChars(doc.chars)}
                      </td>
                      <td style={{ padding: "12px 16px", color: "#64748B", whiteSpace: "nowrap" }}>
                        {formatTime(doc.updated_at)}
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "right", paddingRight: 20 }}>
                        <button
                          onClick={() => setDeleteTarget(doc)}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            padding: "6px 10px",
                            border: "1px solid #E2E8F0",
                            borderRadius: 6,
                            background: "#fff",
                            cursor: "pointer",
                            fontSize: 12,
                            fontWeight: 500,
                            color: "#1E293B",
                            fontFamily: "inherit",
                          }}
                          onMouseEnter={(e) => {
                            (e.currentTarget as HTMLElement).style.background = "#FEF2F2";
                            (e.currentTarget as HTMLElement).style.borderColor = "#DC2626";
                            (e.currentTarget as HTMLElement).style.color = "#DC2626";
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLElement).style.background = "#fff";
                            (e.currentTarget as HTMLElement).style.borderColor = "#E2E8F0";
                            (e.currentTarget as HTMLElement).style.color = "#1E293B";
                          }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div
            style={{
              padding: "10px 20px",
              borderTop: "1px solid #F1F5F9",
              fontSize: 12,
              color: "#94A3B8",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <line x1="12" y1="11" x2="12" y2="16" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            支持 .md / .txt / .csv / .xlsx，单文件 ≤ {MAX_MB} MB；点「切片数」可查看切分后的文本；同名文件重传会原地替换
          </div>
        </div>
      </main>

      {/* ====== 切片详情抽屉 ====== */}
      <KnowledgeChunkDrawer
        key={chunkDoc?.doc_id ?? "none"}
        doc={chunkDoc}
        onClose={() => setChunkDoc(null)}
      />

      {/* ====== 删除确认 ====== */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="删除知识库文档">
        {deleteTarget && (
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 18,
                padding: 16,
                background: "#FEF2F2",
                borderRadius: 10,
                border: "1px solid #FECACA",
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  background: "#FEE2E2",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#DC2626",
                  flexShrink: 0,
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#991B1B", wordBreak: "break-all" }}>
                  确认删除「{deleteTarget.title}」？
                </div>
                <div style={{ fontSize: 12.5, color: "#B91C1C", marginTop: 3, lineHeight: 1.6 }}>
                  该文档的 {deleteTarget.chunks} 个切块与向量会一并移除，Agent 之后将检索不到这些内容。
                </div>
              </div>
            </div>
            {deleteTarget.doc_type !== "file" && (
              <div
                style={{
                  fontSize: 12,
                  color: "#92400E",
                  background: "#FFFBEB",
                  border: "1px solid #FDE68A",
                  borderRadius: 8,
                  padding: "8px 12px",
                  marginBottom: 16,
                  lineHeight: 1.6,
                }}
              >
                这是内置语料（{TYPE_META[deleteTarget.doc_type]?.label ?? deleteTarget.doc_type}），
                删除后如需恢复，请执行 <code>python -m kb.cli ingest</code> 重新导入。
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => void confirmDelete()}
                disabled={deleting}
                style={{
                  flex: 1,
                  padding: "10px 20px",
                  borderRadius: 10,
                  fontWeight: 600,
                  fontSize: 13.5,
                  border: "none",
                  background: deleting ? "#FCA5A5" : "#DC2626",
                  color: "#fff",
                  cursor: deleting ? "wait" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                {deleting ? "删除中…" : "确认删除"}
              </button>
              <button
                onClick={() => setDeleteTarget(null)}
                style={{
                  flex: 1,
                  padding: "10px 20px",
                  borderRadius: 10,
                  fontWeight: 600,
                  fontSize: 13.5,
                  border: "1px solid #E2E8F0",
                  background: "#fff",
                  color: "#1E293B",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
