"use client";

/**
 * 对话 UI 基础元素（参考 agent-chat-ui 素材包）
 * Bot 头像 / 用户头像 / 展开箭头 / 三点思考动画 / 工具图标
 */

/** AI 机器人头像：蓝紫渐变圆角方块 */
export function BotAvatar({ size = 32 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.31),
        background: "linear-gradient(135deg, #2563EB, #7C3AED)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        flexShrink: 0,
        boxShadow: "0 2px 6px rgba(37,99,235,0.22)",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        width={size * 0.55}
        height={size * 0.55}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4" y="8" width="16" height="12" rx="2" />
        <path d="M12 8V4" />
        <circle cx="12" cy="3" r="1" />
        <path d="M9 13h.01" strokeWidth="2.4" />
        <path d="M15 13h.01" strokeWidth="2.4" />
        <path d="M9 17h6" strokeWidth="2" />
      </svg>
    </div>
  );
}

/** 用户头像：蓝色渐变圆角方块 + 首字 */
export function UserAvatar({ initial, size = 30 }: { initial: string; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: "linear-gradient(135deg, #2563EB, #60A5FA)",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: 13,
        flexShrink: 0,
      }}
    >
      {initial}
    </div>
  );
}

/** 展开/收起箭头 */
export function Chevron({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#94A3B8"
      strokeWidth="2"
      width={size}
      height={size}
      style={{
        transform: open ? "rotate(180deg)" : "rotate(0deg)",
        transition: "transform 0.15s",
        flexShrink: 0,
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** 思考中：三个蓝点依次弹跳 */
export function ThinkingDots({ label }: { label?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 2px" }}>
      <span className="thinking-dot" style={{ animationDelay: "0ms" }} />
      <span className="thinking-dot" style={{ animationDelay: "150ms" }} />
      <span className="thinking-dot" style={{ animationDelay: "300ms" }} />
      {label && <span style={{ fontSize: 12.5, color: "#94A3B8", marginLeft: 6 }}>{label}</span>}
    </div>
  );
}

/** 工具图标：按工具名给不同图形 */
export function ToolIcon({ name, size = 13, color = "#64748B" }: { name: string; size?: number; color?: string }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: 2,
    width: size,
    height: size,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (/calc|math|compute/i.test(name)) {
    return (
      <svg {...common}>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8" />
        <path d="M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" strokeWidth="2.6" />
      </svg>
    );
  }
  if (/time|clock|date/i.test(name)) {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <polyline points="12 7 12 12 15.5 14" />
      </svg>
    );
  }
  if (/lead|crm|order|product|customer/i.test(name)) {
    return (
      <svg {...common}>
        <path d="M20 7H4a1 1 0 0 0-1 1v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a1 1 0 0 0-1-1z" />
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <path d="M3 12h18" />
      </svg>
    );
  }
  if (/todo|task|plan|write_todos/i.test(name)) {
    return (
      <svg {...common}>
        <path d="M9 6h11M9 12h11M9 18h11" />
        <path d="M4 6l1.2 1.2L7.5 4.8M4 12l1.2 1.2L7.5 10.8M4 18l1.2 1.2L7.5 16.8" />
      </svg>
    );
  }
  if (/file|read|write|ls|glob|grep/i.test(name)) {
    return (
      <svg {...common}>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <polyline points="14 3 14 8 19 8" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M14.7 6.3a4 4 0 0 0 5.3 5.3l-8.6 8.6a2.3 2.3 0 0 1-3.3-3.3l8.6-8.6z" />
      <path d="M6 6l3 3" />
    </svg>
  );
}

/** 复制 / 已复制图标 */
export function CopyIcon({ copied, size = 12 }: { copied: boolean; size?: number }) {
  return copied ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2.6" width={size} height={size} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width={size} height={size} strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
