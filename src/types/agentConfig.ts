/** Agent 控制面板：与 agent/app.py 的 /config、/health、/metrics/overview 对齐的类型 */

export type ToolPermission = "direct" | "approval" | "forbidden";

export interface AgentToolRow {
  name: string;
  label: string;
  category: "system" | "query" | "write" | "delete" | string;
  category_label: string;
  summary: string;
  enabled: boolean;
  permission: ToolPermission;
  permission_label: string;
  /** 产品规则锁死的工具（删除类），不可开启也不可改权限 */
  locked: boolean;
  lock_reason: string;
}

export interface AgentConfigStats {
  total: number;
  enabled: number;
  approval: number;
  direct: number;
  forbidden: number;
}

export interface AgentConfigView {
  system_prompt: string;
  default_prompt: string;
  is_default_prompt: boolean;
  prompt_length: number;
  tools: AgentToolRow[];
  stats: AgentConfigStats;
  revision: string;
  updated_at: string;
  updated_by: string;
  permission_options: { value: ToolPermission; label: string }[];
}

export interface MetricsBucket {
  calls: number;
  avg_ms: number;
  p95_ms?: number;
  tool_calls: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  errors: number;
  threads: number;
}

export interface MetricsOverview {
  today: MetricsBucket & { day: string; p95_ms: number };
  yesterday: MetricsBucket;
  trend: { day: string; calls: number; tokens: number; avg_ms: number }[];
  top_tools: { name: string; count: number }[];
  last_call_at: string;
  generated_at: string;
  model: string;
}

export interface AgentHealth {
  status: string;
  framework: string;
  model: string;
  api_base: string;
  storage: string;
  uptime_s: number;
  started_at: string;
  config_revision: string;
  tools: string[];
  tools_total: number;
}

export interface ModelProbe {
  ok: boolean;
  model: string;
  latency_ms: number;
  message?: string;
  reply?: string;
  total_tokens?: number;
  checked_at?: string;
}

/**
 * 控制面板只给系统管理员看。
 *
 * 判据是「账号管理 → 修改」这一功能位：只有管理员角色同时具备页面和修改权，
 * 和 agent/agent_config.py 的 can_manage 保持一致（后端还会再校验一次）。
 */
export function canManageAgent(
  role: { permissions: { pageKey: string; functions: string[] }[] } | null,
): boolean {
  if (!role) return false;
  const perm = role.permissions.find((item) => item.pageKey === "accounts");
  return !!perm && perm.functions.includes("修改");
}
