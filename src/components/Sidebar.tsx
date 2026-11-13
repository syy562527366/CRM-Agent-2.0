"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { canAccessPage } from "@/hooks/usePermission";
import { canManageAgent } from "@/types/agentConfig";
import UserCenterModal from "./UserCenterModal";

interface SidebarProps {
  activeItem: string;
}

export default function Sidebar({ activeItem }: SidebarProps) {
  const { user, role } = useAuth();
  const [showUserCenter, setShowUserCenter] = useState(false);

  const navItems = [
    {
      key: "dashboard",
      label: "数据仪表盘",
      href: "/dashboard",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
        </svg>
      ),
    },
    {
      key: "leads",
      label: "线索管理",
      href: "/leads",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      ),
    },
    {
      key: "products",
      label: "商品管理",
      href: "/products",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
      ),
    },
    {
      key: "orders",
      label: "订单管理",
      href: "/orders",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      ),
    },
    {
      key: "roles",
      label: "角色与权限",
      href: "/roles",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      ),
    },
    {
      key: "accounts",
      label: "账号管理",
      href: "/accounts",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      ),
    },
    {
      key: "communications",
      label: "沟通记录",
      href: "/communications",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      ),
    },
  ];

  // 根据角色权限过滤导航项
  const visibleNavItems = navItems.filter((item) => canAccessPage(role, item.key));
  const canUseAgent = canAccessPage(role, "agent");
  // 控制面板会改 Agent 的行为边界，只给系统管理员（账号管理 → 修改）
  const canManage = canManageAgent(role);

  return (
    <aside className="w-60 min-w-60 bg-[#0F172A] flex flex-col h-screen sticky top-0 overflow-y-auto">
      {/* Logo */}
      <div className="px-5 py-6 border-b border-white/10">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-400 flex items-center justify-center text-white font-extrabold text-sm">
            C
          </div>
          <div>
            <div className="font-bold text-base text-slate-100 tracking-tight">CRM</div>
            <div className="text-[11px] text-slate-500 font-medium">客户管理平台</div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="px-3 py-3 flex-1">
        <div className="text-[11px] font-semibold text-slate-600 uppercase tracking-widest px-3 pb-1.5 pt-1">
          业务管理
        </div>
        {visibleNavItems.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className={`flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer mb-0.5 relative ${
              activeItem === item.key
                ? "bg-blue-500/15 text-blue-400 before:absolute before:left-[-12px] before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-5 before:bg-blue-500 before:rounded-r"
                : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
            }`}
          >
            <span className={`w-5 h-5 shrink-0 ${activeItem === item.key ? "opacity-100" : "opacity-80"}`}>
              {item.icon}
            </span>
            <span>{item.label}</span>
          </Link>
        ))}

        {canUseAgent && (
          <>
            <div className="text-[11px] font-semibold text-slate-600 uppercase tracking-widest px-3 pb-1.5 pt-4">
              智能助手
            </div>
            <Link
              href="/agent"
              className={`flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer mb-0.5 relative ${
                activeItem === "agent"
                  ? "bg-blue-500/15 text-blue-400 before:absolute before:left-[-12px] before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-5 before:bg-blue-500 before:rounded-r"
                  : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
              }`}
            >
              <span className={`w-5 h-5 shrink-0 ${activeItem === "agent" ? "opacity-100" : "opacity-80"}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-4-.8L3 21l1.9-4.6a8.4 8.4 0 0 1-.9-3.9 8.4 8.4 0 0 1 8.5-8.4 8.4 8.4 0 0 1 8.5 7.4z" />
                  <path d="M12 8.2l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4z" />
                </svg>
              </span>
              <span>AI 助手</span>
              <span className="ml-auto text-[10px] font-bold text-blue-400/90 bg-blue-500/15 border border-blue-400/25 rounded px-1.5 py-px">
                AI
              </span>
            </Link>
            {canManage && (
              <Link
                href="/agent-settings"
                className={`flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer mb-0.5 relative ${
                  activeItem === "agent-settings"
                    ? "bg-blue-500/15 text-blue-400 before:absolute before:left-[-12px] before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-5 before:bg-blue-500 before:rounded-r"
                    : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
                }`}
              >
                <span className={`w-5 h-5 shrink-0 ${activeItem === "agent-settings" ? "opacity-100" : "opacity-80"}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
                  </svg>
                </span>
                <span>Agent 控制面板</span>
              </Link>
            )}
            {canManage && (
              <Link
                href="/agent-kb"
                className={`flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer mb-0.5 relative ${
                  activeItem === "agent-kb"
                    ? "bg-blue-500/15 text-blue-400 before:absolute before:left-[-12px] before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-5 before:bg-blue-500 before:rounded-r"
                    : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
                }`}
              >
                <span className={`w-5 h-5 shrink-0 ${activeItem === "agent-kb" ? "opacity-100" : "opacity-80"}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                    <line x1="9" y1="7" x2="16" y2="7" />
                    <line x1="9" y1="11" x2="16" y2="11" />
                  </svg>
                </span>
                <span>知识库管理</span>
              </Link>
            )}
          </>
        )}
      </nav>

      {/* User */}
      <div className="px-3 py-4 border-t border-white/10">
        <div
          className="flex items-center gap-2.5 px-3.5 py-2 rounded-lg cursor-pointer hover:bg-white/5 transition-colors"
          onClick={() => setShowUserCenter(true)}
        >
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-400 flex items-center justify-center text-white font-bold text-xs">
            {user ? user.name[0] : "?"}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-300">{user?.name ?? "未登录"}</div>
            <div className="text-[11px] text-slate-500">{user?.roleName ?? ""}</div>
          </div>
          <svg viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2" width="14" height="14" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </div>

      <UserCenterModal open={showUserCenter} onClose={() => setShowUserCenter(false)} />
    </aside>
  );
}
