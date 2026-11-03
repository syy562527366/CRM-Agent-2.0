"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { PermissionItem } from "@/types/role";

export interface AuthUser {
  id: string;
  createdAt: string;
  phone: string;
  name: string;
  roleId: string;
  roleName: string;
}

export interface AuthRole {
  id: string;
  name: string;
  permissions: PermissionItem[];
}

interface AuthState {
  user: AuthUser | null;
  role: AuthRole | null;
  token: string | null;
  loading: boolean;
  login: (phone: string, password: string) => Promise<string | null>;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

const STORAGE_KEY = "crm_auth";
/** 会话本体是 HttpOnly Cookie，前端拿不到，这里只存一个标记用于渲染判断 */
const COOKIE_SESSION = "cookie-session";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [role, setRole] = useState<AuthRole | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    setUser(null);
    setRole(null);
    setToken(null);
    localStorage.removeItem(STORAGE_KEY);
    // 清除服务端 HttpOnly 会话 Cookie（失败也不影响本地登出）
    void fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  }, []);

  /**
   * 页面加载时恢复登录状态。
   *
   * 先读 localStorage 避免白屏，再用 /api/auth/session 以服务端为准校验：
   * - 200：同步最新的账号信息与角色权限（管理员改过权限后刷新即生效）
   * - 401：Cookie 过期或token 无效 → 直接登出
   */
  useEffect(() => {
    (async () => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        const cached = stored ? JSON.parse(stored) : null;
        if (cached?.user) {
          setUser(cached.user);
          setRole(cached.role);
          setToken(cached.token ?? COOKIE_SESSION);
        }

        const res = await fetch("/api/auth/session", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          const nextToken = cached?.token ?? COOKIE_SESSION;
          setUser(data.user);
          setRole(data.role);
          setToken(nextToken);
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ user: data.user, role: data.role, token: nextToken })
          );
        } else if (stored) {
          // 服务端会话已失效
          setUser(null);
          setRole(null);
          setToken(null);
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch {
        // 网络异常时保留缓存状态，避免误踢下线
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (phone: string, password: string): Promise<string | null> => {
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, password }),
      });

      if (!res.ok) {
        const err = await res.json();
        return err.error || "登录失败";
      }

      const data = await res.json();
      setUser(data.user);
      setRole(data.role);
      setToken(data.token);

      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ user: data.user, role: data.role, token: data.token })
      );

      return null; // 无错误
    } catch {
      return "网络错误，请稍后重试";
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        role,
        token,
        loading,
        login,
        logout,
        isAuthenticated: !!token,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
