"use client";

/**
 * Markdown 渲染器（参考 agent-chat-ui 素材包）
 * - 标题序号徽章、引用块紫条、表格斑马纹 + 悬浮高亮
 * - 代码块深色底 + 语言标签 + 一键复制
 * - 徽章语法糖（[意向：高] / [原因：价格异议] 等）
 * - 特殊围栏（```lead-report / ```lead-analysis-card）交给上层渲染结构化卡片
 *
 * 围栏渲染器的契约：返回 null / undefined 表示「还解析不出来」。
 * 这时按 `streaming` 区分两种状态 —— 流式中显示占位动画，流式结束后
 * 显示原始内容与错误提示。少了这个区分，模型写错 JSON 会让占位动画永远转下去，
 * 用户既看不到卡片也看不到原因。
 */
import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 围栏渲染器：拿到围栏内的原始文本，返回卡片节点；解析不出来就返回 null */
export type FenceRenderer = (raw: string) => React.ReactNode;

export interface MarkdownOptions {
  /** 自定义围栏：```<lang> → 渲染器 */
  fences?: Record<string, FenceRenderer>;
  /** 是否仍在流式输出，决定围栏解析失败时显示占位还是回退原文 */
  streaming?: boolean;
}

/** 围栏语言的展示名，只用于文案 */
const FENCE_LABEL: Record<string, string> = {
  "lead-report": "分析卡片",
  "lead-analysis-card": "分析卡片",
};

/* ===== 徽章语法糖 ===== */
const BADGES: Record<string, { bg: string; color: string; label: string }> = {
  "[意向：高]": { bg: "#FEE2E2", color: "#DC2626", label: "意向 · 高" },
  "[意向：中]": { bg: "#FEF3C7", color: "#D97706", label: "意向 · 中" },
  "[意向：低]": { bg: "#F1F5F9", color: "#64748B", label: "意向 · 低" },
  "[态度：积极]": { bg: "#DCFCE7", color: "#16A34A", label: "积极" },
  "[态度：中性]": { bg: "#F1F5F9", color: "#64748B", label: "中性" },
  "[态度：负面]": { bg: "#FEE2E2", color: "#DC2626", label: "负面" },
  "[态度：价格敏感]": { bg: "#FFFBEB", color: "#D97706", label: "价格敏感" },
  "[降级模式]": { bg: "#FEF3C7", color: "#92400E", label: "降级模式" },
};

const REASONS: Record<string, { bg: string; color: string }> = {
  价格异议: { bg: "#FEE2E2", color: "#DC2626" },
  预算不足: { bg: "#FEF3C7", color: "#D97706" },
  选择了竞品: { bg: "#FEE2E2", color: "#DC2626" },
  需求不匹配: { bg: "#F1F5F9", color: "#64748B" },
  跟进不及时: { bg: "#FEF3C7", color: "#D97706" },
  其他: { bg: "#F1F5F9", color: "#64748B" },
};

function inlineBadge(text: string): React.ReactNode {
  const trimmed = text.trim();
  const hit = BADGES[trimmed];
  if (hit) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          background: hit.bg,
          color: hit.color,
          fontSize: 11.5,
          fontWeight: 600,
          padding: "1.5px 8px",
          borderRadius: 4,
          lineHeight: 1.6,
        }}
      >
        {hit.label}
      </span>
    );
  }
  const reason = /^\[原因：(.+)\]$/.exec(trimmed);
  if (reason) {
    const s = REASONS[reason[1]] ?? REASONS["其他"];
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          background: s.bg,
          color: s.color,
          fontSize: 11.5,
          fontWeight: 600,
          padding: "1.5px 8px",
          borderRadius: 4,
          lineHeight: 1.6,
        }}
      >
        {reason[1]}
      </span>
    );
  }
  return null;
}

/* ===== 代码块 ===== */
function CodeBlock({ lang, code, children }: { lang: string; code: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用则静默 */
    }
  };

  return (
    <div
      style={{
        position: "relative",
        margin: "10px 0",
        background: "#0F172A",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 10px 6px 12px",
          borderBottom: "1px solid rgba(148,163,184,0.16)",
        }}
      >
        <span
          style={{
            fontSize: 11,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "#94A3B8",
            fontWeight: 600,
          }}
        >
          {lang || "code"}
        </span>
        <button
          onClick={() => void handleCopy()}
          title="复制代码"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            border: "none",
            background: "transparent",
            color: copied ? "#4ADE80" : "#94A3B8",
            fontSize: 11,
            fontFamily: "inherit",
            cursor: "pointer",
            padding: "2px 4px",
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre style={{ margin: 0, padding: "11px 14px", overflowX: "auto", background: "transparent" }}>{children}</pre>
    </div>
  );
}

/* ===== 围栏降级：生成中 / 解析失败 ===== */

function FencePending({ label }: { label: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "10px 0",
        padding: "11px 14px",
        border: "1px solid #E2E8F0",
        borderRadius: 10,
        background: "#F8FAFC",
      }}
    >
      <span className="chat-spin" />
      <span style={{ fontSize: 13, color: "#64748B" }}>正在生成{label}…</span>
    </div>
  );
}

function FenceBroken({ lang, raw }: { lang: string; raw: string }) {
  return (
    <div
      style={{
        margin: "10px 0",
        border: "1px solid #FDE68A",
        borderRadius: 10,
        background: "#FFFBEB",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "9px 13px",
          borderBottom: "1px solid #FEF3C7",
        }}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#D97706" strokeWidth="2" strokeLinecap="round">
          <path d="M12 9v4M12 17h.01" />
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </svg>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "#B45309" }}>卡片数据不完整，已显示原始内容</span>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "10px 13px",
          maxHeight: 200,
          overflow: "auto",
          fontSize: 11.5,
          lineHeight: 1.6,
          color: "#78350F",
          fontFamily: '"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace',
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {raw || "（空）"}
      </pre>
      <div style={{ padding: "0 13px 10px", fontSize: 11, color: "#B45309", opacity: 0.8 }}>
        围栏标识：{lang || "(未指定)"}
      </div>
    </div>
  );
}

/* ===== 组件映射 ===== */
export function createMarkdownComponents(opts?: MarkdownOptions) {
  let headingIndex = 0;

  return {
    h1: ({ children }: { children?: React.ReactNode }) => (
      <h1 style={{ fontSize: 18, fontWeight: 700, color: "#0F172A", margin: "16px 0 8px", lineHeight: 1.4 }}>{children}</h1>
    ),
    h2: ({ children }: { children?: React.ReactNode }) => (
      <h2 style={{ fontSize: 16.5, fontWeight: 700, color: "#0F172A", margin: "16px 0 7px", lineHeight: 1.4 }}>{children}</h2>
    ),
    h3: ({ children }: { children?: React.ReactNode }) => {
      const text = String(children ?? "");
      // 已有编号（「1.」「步骤一」等）不再重复加徽章
      const numbered = /^\s*(\d+[.、)]|[一二三四五六七八九十]+[、.]|步骤)/.test(text);
      headingIndex += 1;
      const badgeNo = numbered ? null : headingIndex;
      return (
        <h3
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: "#0F172A",
            margin: "14px 0 6px",
            lineHeight: 1.45,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {badgeNo !== null && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 20,
                height: 20,
                borderRadius: 5,
                background: "#EEF2FF",
                color: "#4338CA",
                fontSize: 11,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {badgeNo}
            </span>
          )}
          {children}
        </h3>
      );
    },
    h4: ({ children }: { children?: React.ReactNode }) => (
      <h4 style={{ fontSize: 14, fontWeight: 700, color: "#0F172A", margin: "12px 0 5px" }}>{children}</h4>
    ),
    p: ({ children }: { children?: React.ReactNode }) => (
      <p style={{ margin: "0 0 10px", lineHeight: 1.75, fontSize: 14 }}>{children}</p>
    ),
    ul: ({ children }: { children?: React.ReactNode }) => (
      <ul style={{ margin: "0 0 10px", paddingLeft: 20, listStyle: "disc" }}>{children}</ul>
    ),
    ol: ({ children }: { children?: React.ReactNode }) => (
      <ol style={{ margin: "0 0 10px", paddingLeft: 20, listStyle: "decimal" }}>{children}</ol>
    ),
    li: ({ children }: { children?: React.ReactNode }) => (
      <li style={{ margin: "3px 0", lineHeight: 1.7, fontSize: 14 }}>{children}</li>
    ),
    strong: ({ children }: { children?: React.ReactNode }) => (
      <strong style={{ fontWeight: 700, color: "#0F172A" }}>{children}</strong>
    ),
    em: ({ children }: { children?: React.ReactNode }) => <em style={{ fontStyle: "italic" }}>{children}</em>,
    a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        style={{ color: "#2563EB", textDecoration: "underline", textUnderlineOffset: 2 }}
      >
        {children}
      </a>
    ),
    code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
      const isBlock = /language-/.test(className ?? "") || String(children).includes("\n");
      if (isBlock) {
        return (
          <code
            style={{
              fontFamily: '"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace',
              fontSize: 12.5,
              lineHeight: 1.65,
              color: "#E2E8F0",
              whiteSpace: "pre",
            }}
          >
            {children}
          </code>
        );
      }
      const badge = inlineBadge(String(children ?? ""));
      if (badge) return <>{badge}</>;
      return (
        <code
          style={{
            fontFamily: '"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace',
            fontSize: 12.5,
            background: "#F1F5F9",
            color: "#1D4ED8",
            padding: "1.5px 5px",
            borderRadius: 4,
          }}
        >
          {children}
        </code>
      );
    },
    pre: ({ children }: { children?: React.ReactNode }) => {
      const arr = React.Children.toArray(children);
      const first = arr.find((c) => React.isValidElement(c));
      const props = React.isValidElement(first)
        ? (first.props as { className?: string; children?: React.ReactNode })
        : undefined;
      const lang = /language-([\w-]+)/.exec(props?.className ?? "")?.[1] ?? "";
      const raw = String(props?.children ?? "");

      // 自定义围栏：```lead-report / ```lead-analysis-card
      const custom = lang ? opts?.fences?.[lang] : undefined;
      if (custom) {
        const rendered = custom(raw.trim());
        if (rendered !== null && rendered !== undefined) return <>{rendered}</>;
        // 解析不出来：流式中是「JSON 还没闭合」，结束后就是「模型写错了」
        if (opts?.streaming) return <FencePending label={FENCE_LABEL[lang] ?? "卡片"} />;
        return <FenceBroken lang={lang} raw={raw.trim()} />;
      }

      // 流式途中围栏语言只敲了一半（```lead-rep），别让它先闪成一个深色代码块
      if (opts?.streaming && /^lead-/.test(lang) && !opts?.fences?.[lang]) {
        return <FencePending label="分析卡片" />;
      }

      return (
        <CodeBlock lang={lang} code={raw}>
          {children}
        </CodeBlock>
      );
    },
    blockquote: ({ children }: { children?: React.ReactNode }) => (
      <blockquote
        style={{
          margin: "10px 0",
          padding: "10px 14px 10px 16px",
          borderLeft: "3px solid #6366F1",
          background: "#F5F3FF",
          borderRadius: "0 10px 10px 0",
          color: "#475569",
        }}
      >
        {children}
      </blockquote>
    ),
    table: ({ children }: { children?: React.ReactNode }) => (
      <div className="chat-table-wrap">
        <table>{children}</table>
      </div>
    ),
    th: ({ children }: { children?: React.ReactNode }) => <th>{children}</th>,
    td: ({ children }: { children?: React.ReactNode }) => <td>{children}</td>,
    hr: () => <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid #E2E8F0" }} />,
    img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        {...props}
        alt={props.alt ?? ""}
        style={{ maxWidth: "100%", borderRadius: 8, margin: "8px 0", ...props.style }}
      />
    ),
  };
}

export default function MarkdownRenderer({
  content,
  fences,
  streaming,
}: {
  content: string;
  fences?: Record<string, FenceRenderer>;
  streaming?: boolean;
}) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents({ fences, streaming })}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
