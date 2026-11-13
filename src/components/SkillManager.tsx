"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Modal from "./Modal";

/**
 * Skill 管理页签。
 *
 * 技能是「渐进式披露」的：每轮只把 name + description 注入提示词，模型需要时
 * 自己 read_file 读 SKILL.md。所以开关的语义必须落在目录上 —— 关闭 = 目录移出
 * 扫描范围，模型既看不到它的 name/description，也读不到正文。
 * 详情见 agent/skills_store.py 里 DISABLED_DIR 的注释。
 */

const AGENT_BASE = "/agent-api";

interface SkillRow {
  name: string;
  dir: string;
  description: string;
  path: string;
  files: string[];
  enabled: boolean;
  valid: boolean;
  errors: string[];
  include_tools?: string[];
  allowed_tools?: string[];
}

interface SkillsPayload {
  ok?: boolean;
  total?: number;
  valid?: number;
  enabled?: number;
  disabled?: number;
  invalid?: number;
  skills?: SkillRow[];
  root?: string;
  disabled_root?: string;
  detail?: string;
}

const CARD: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #E2E8F0",
  borderRadius: 12,
};

function Toggle({
  checked,
  disabled,
  title,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onChange: (next: boolean) => void;
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
        cursor: disabled ? "wait" : "pointer",
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

function Chip({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span
      style={{
        fontSize: 11.5,
        fontWeight: 500,
        padding: "3px 9px",
        borderRadius: 6,
        color,
        background: bg,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

export default function SkillManager({
  notify,
}: {
  notify: (text: string, ok?: boolean) => void;
}) {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [meta, setMeta] = useState<SkillsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");

  const [editName, setEditName] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [original, setOriginal] = useState("");
  const [loadingContent, setLoadingContent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const apply = useCallback((payload: SkillsPayload) => {
    setSkills(payload.skills ?? []);
    setMeta(payload);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${AGENT_BASE}/skills`, { cache: "no-store" });
      const data = (await res.json()) as SkillsPayload;
      if (!res.ok) {
        setError(data.detail ?? `读取技能列表失败（HTTP ${res.status}）`);
        return;
      }
      setError("");
      apply(data);
    } catch {
      setError("Agent 服务不可达，读不到技能列表");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    // 异步拉取，不在 effect 体内同步 setState
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  /* ---------- 开关 ---------- */
  const toggle = useCallback(
    async (skill: SkillRow, next: boolean) => {
      setBusy(skill.name);
      // 先本地翻转，点下去立刻有反馈；失败再回滚
      setSkills((prev) => prev.map((s) => (s.name === skill.name ? { ...s, enabled: next } : s)));
      try {
        const res = await fetch(`${AGENT_BASE}/skills/${skill.name}/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: next }),
        });
        const data = (await res.json()) as SkillsPayload;
        if (!res.ok) {
          setSkills((prev) => prev.map((s) => (s.name === skill.name ? { ...s, enabled: !next } : s)));
          notify(data.detail ?? `操作失败（HTTP ${res.status}）`, false);
          return;
        }
        apply(data);
        notify(next ? `已启用「${skill.name}」，下一句话就能用` : `已关闭「${skill.name}」，模型不再看到它`);
      } catch (err) {
        setSkills((prev) => prev.map((s) => (s.name === skill.name ? { ...s, enabled: !next } : s)));
        notify(err instanceof Error ? err.message : "操作失败", false);
      } finally {
        setBusy(null);
      }
    },
    [apply, notify],
  );

  /* ---------- 编辑 ---------- */
  const openEdit = useCallback(
    async (skill: SkillRow) => {
      setEditName(skill.name);
      setDraft("");
      setOriginal("");
      setSaveError("");
      setLoadingContent(true);
      try {
        const res = await fetch(`${AGENT_BASE}/skills/${skill.name}`, { cache: "no-store" });
        const data = (await res.json()) as { skill?: SkillRow & { content?: string }; detail?: string };
        if (!res.ok || !data.skill?.content) {
          setSaveError(data.detail ?? `读取失败（HTTP ${res.status}）`);
          return;
        }
        setDraft(data.skill.content);
        setOriginal(data.skill.content);
      } catch {
        setSaveError("读取 SKILL.md 失败，Agent 服务可能不可达");
      } finally {
        setLoadingContent(false);
      }
    },
    [],
  );

  const closeEdit = useCallback(() => {
    setEditName(null);
    setDraft("");
    setOriginal("");
    setSaveError("");
  }, []);

  const save = useCallback(async () => {
    if (!editName) return;
    setSaving(true);
    setSaveError("");
    try {
      const res = await fetch(`${AGENT_BASE}/skills/${editName}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      const data = (await res.json()) as SkillsPayload;
      if (!res.ok) {
        setSaveError(data.detail ?? `保存失败（HTTP ${res.status}）`);
        return;
      }
      apply(data);
      notify(`「${editName}」已保存，下一句话按新内容执行`);
      closeEdit();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [apply, closeEdit, draft, editName, notify]);

  const visible = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return skills;
    return skills.filter(
      (s) => s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw),
    );
  }, [skills, keyword]);

  const dirty = draft !== original;
  const editing = editName ? skills.find((s) => s.name === editName) : null;

  return (
    <div>
      {/* 概览 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {meta && (
          <>
            <Chip label={`共 ${meta.total ?? 0} 个技能`} color="#475569" bg="#F1F5F9" />
            <Chip label={`已启用 ${meta.enabled ?? 0}`} color="#15803D" bg="#F0FDF4" />
            <Chip label={`已关闭 ${meta.disabled ?? 0}`} color="#64748B" bg="#F8FAFC" />
            {(meta.invalid ?? 0) > 0 && (
              <Chip label={`校验未通过 ${meta.invalid}`} color="#B91C1C" bg="#FEF2F2" />
            )}
          </>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索技能名 / 简介"
            style={{
              width: 200,
              padding: "7px 10px",
              border: "1px solid #E2E8F0",
              borderRadius: 8,
              fontSize: 12.5,
              fontFamily: "inherit",
              color: "#1E293B",
              outline: "none",
            }}
          />
          <button
            onClick={() => {
              setLoading(true);
              void load();
            }}
            disabled={loading}
            style={{
              padding: "7px 13px",
              borderRadius: 8,
              border: "1px solid #E2E8F0",
              background: "#fff",
              color: "#475569",
              fontSize: 12.5,
              fontWeight: 500,
              fontFamily: "inherit",
              cursor: loading ? "wait" : "pointer",
            }}
          >
            刷新
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            ...CARD,
            borderColor: "#FECACA",
            background: "#FFFBFB",
            padding: "12px 16px",
            marginBottom: 12,
            fontSize: 12.5,
            color: "#B91C1C",
          }}
        >
          {error}
        </div>
      )}

      {/* 列表 */}
      <div style={{ ...CARD, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#F8FAFC" }}>
              {["Skill", "功能简介", "状态", "操作"].map((title, i) => (
                <th
                  key={title}
                  style={{
                    padding: "10px 16px",
                    textAlign: i === 3 ? "right" : "left",
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
            {loading && skills.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: "40px 16px", textAlign: "center", color: "#94A3B8", fontSize: 13 }}>
                  正在读取技能…
                </td>
              </tr>
            )}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: "40px 16px", textAlign: "center", color: "#94A3B8", fontSize: 13 }}>
                  {skills.length === 0 ? "技能目录里还没有技能" : "没有匹配的技能"}
                </td>
              </tr>
            )}
            {visible.map((skill) => (
              <tr
                key={skill.dir}
                style={{
                  borderBottom: "1px solid #F1F5F9",
                  background: skill.enabled ? "#fff" : "#FCFDFE",
                }}
              >
                <td style={{ padding: "12px 16px", minWidth: 190 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: skill.enabled ? "#1E293B" : "#94A3B8" }}>
                      {skill.name}
                    </span>
                    {!skill.valid && (
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 600,
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: "#FEF2F2",
                          color: "#B91C1C",
                          border: "1px solid #FECACA",
                        }}
                      >
                        校验未通过
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: "#94A3B8",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                      marginTop: 2,
                    }}
                  >
                    {skill.enabled ? `/skills/${skill.dir}/` : `/skills-disabled/${skill.dir}/`}
                    {skill.files.length > 0 && ` · ${skill.files.length} 个附件`}
                  </div>
                </td>
                <td style={{ padding: "12px 16px", maxWidth: 460 }}>
                  <div style={{ fontSize: 12.5, color: skill.enabled ? "#475569" : "#94A3B8", lineHeight: 1.65 }}>
                    {skill.description || <span style={{ color: "#B91C1C" }}>（frontmatter 缺少 description）</span>}
                  </div>
                  {!skill.valid && (
                    <div style={{ fontSize: 11.5, color: "#B91C1C", marginTop: 4, lineHeight: 1.6 }}>
                      {skill.errors.join("；")}
                    </div>
                  )}
                </td>
                <td style={{ padding: "12px 16px", width: 110 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <Toggle
                      checked={skill.enabled}
                      disabled={busy === skill.name}
                      title={skill.enabled ? "点击关闭：模型不再看到这个技能" : "点击启用"}
                      onChange={(next) => void toggle(skill, next)}
                    />
                    <span
                      style={{
                        fontSize: 11.5,
                        color: skill.enabled ? "#15803D" : "#94A3B8",
                        fontWeight: 500,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {skill.enabled ? "已启用" : "已关闭"}
                    </span>
                  </div>
                </td>
                <td style={{ padding: "12px 16px", textAlign: "right", width: 90 }}>
                  <button
                    onClick={() => void openEdit(skill)}
                    style={{
                      padding: "6px 12px",
                      border: "1px solid #E2E8F0",
                      borderRadius: 6,
                      background: "#fff",
                      color: "#1E293B",
                      fontSize: 12,
                      fontWeight: 500,
                      fontFamily: "inherit",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "#EFF6FF";
                      (e.currentTarget as HTMLElement).style.borderColor = "#BFDBFE";
                      (e.currentTarget as HTMLElement).style.color = "#2563EB";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "#fff";
                      (e.currentTarget as HTMLElement).style.borderColor = "#E2E8F0";
                      (e.currentTarget as HTMLElement).style.color = "#1E293B";
                    }}
                  >
                    编辑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 14, padding: "12px 14px", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 9, fontSize: 12, color: "#64748B", lineHeight: 1.75 }}>
        <strong style={{ color: "#334155" }}>开关是目录级的</strong>：关闭时目录会移到{" "}
        <code style={{ fontFamily: "ui-monospace, monospace" }}>agent/skills-disabled/</code>，
        模型既看不到技能的 name / description，也无法用{" "}
        <code style={{ fontFamily: "ui-monospace, monospace" }}>read_file</code> 读它的正文。
        改完保存即刻生效，不用重启服务；关闭状态的技能仍可编辑。
      </div>

      {/* 编辑弹窗 */}
      <Modal open={!!editName} onClose={closeEdit} title={`编辑 Skill：${editName ?? ""}`} width="820px">
        {loadingContent ? (
          <div style={{ padding: "40px 0", textAlign: "center", color: "#94A3B8", fontSize: 13 }}>
            正在读取 SKILL.md…
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <span
                style={{
                  fontSize: 11.5,
                  color: "#475569",
                  background: "#F1F5F9",
                  borderRadius: 6,
                  padding: "3px 8px",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {editing?.enabled ? "/skills/" : "/skills-disabled/"}
                {editName}/SKILL.md
              </span>
              <span style={{ fontSize: 11.5, color: "#94A3B8" }}>
                {draft.length.toLocaleString("zh-CN")} 字符 ·{" "}
                {draft ? draft.split("\n").length : 0} 行
              </span>
              {dirty && <span style={{ fontSize: 11.5, color: "#C2410C", fontWeight: 600 }}>未保存</span>}
            </div>

            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              style={{
                width: "100%",
                height: 400,
                boxSizing: "border-box",
                padding: "12px 14px",
                border: "1px solid #E2E8F0",
                borderRadius: 10,
                background: "#0F172A",
                color: "#E2E8F0",
                fontSize: 12.5,
                lineHeight: 1.7,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                resize: "vertical",
                outline: "none",
                tabSize: 2,
              }}
            />

            <div style={{ fontSize: 11.5, color: "#94A3B8", marginTop: 8, lineHeight: 1.7 }}>
              保存前会按启动时的同一套规则校验：YAML frontmatter 必须存在、
              <code style={{ fontFamily: "ui-monospace, monospace" }}>name</code> 必须等于目录名{" "}
              <strong style={{ color: "#475569" }}>{editName}</strong>、description 不能为空且不超过 1024 字、
              正文不能为空。校验不过不会写盘，原文保持不动。
            </div>

            {saveError && (
              <div
                style={{
                  marginTop: 10,
                  padding: "9px 12px",
                  borderRadius: 8,
                  background: "#FEF2F2",
                  border: "1px solid #FECACA",
                  color: "#B91C1C",
                  fontSize: 12.5,
                  lineHeight: 1.7,
                }}
              >
                {saveError}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button
                onClick={() => void save()}
                disabled={saving || !dirty || loadingContent}
                style={{
                  flex: 1,
                  padding: "10px 20px",
                  borderRadius: 10,
                  border: "none",
                  background: saving ? "#93C5FD" : !dirty ? "#E2E8F0" : "#2563EB",
                  color: !dirty ? "#94A3B8" : "#fff",
                  fontWeight: 600,
                  fontSize: 13.5,
                  fontFamily: "inherit",
                  cursor: saving ? "wait" : !dirty ? "not-allowed" : "pointer",
                }}
              >
                {saving ? "保存中…" : "保存并生效"}
              </button>
              <button
                onClick={closeEdit}
                style={{
                  flex: 1,
                  padding: "10px 20px",
                  borderRadius: 10,
                  border: "1px solid #E2E8F0",
                  background: "#fff",
                  color: "#1E293B",
                  fontWeight: 600,
                  fontSize: 13.5,
                  fontFamily: "inherit",
                  cursor: "pointer",
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
