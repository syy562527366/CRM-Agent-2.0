/**
 * Agent 服务异常的统一定性。
 *
 * 背景：Agent 后端（3200）是独立进程，挂掉的时候前端代理 `/agent-api/*`
 * 只会回一个裸 502。用户看到「HTTP 502」完全无法判断是自己操作错、
 * 权限不够，还是进程根本没开。这里把状态码翻译成「结论 + 怎么办」，
 * 让 AI 助手页和 Agent 控制面板说同一套话。
 */

export type AgentFailureKind = "offline" | "unauthorized" | "forbidden" | "server" | "unknown";

export interface AgentFailure {
  kind: AgentFailureKind;
  /** 一句话结论，可直接当标题用 */
  title: string;
  /** 补充说明：为什么、影响什么 */
  detail: string;
  /** 该在终端里执行的命令（仅 offline 有） */
  command?: string;
}

/** 手动启动 Agent 的命令（工作目录为项目根目录） */
export const AGENT_START_COMMAND = "cd agent && .venv\\Scripts\\python.exe app.py";

const OFFLINE: AgentFailure = {
  kind: "offline",
  title: "Agent 服务没有启动",
  detail:
    "CRM 前端正常，但 127.0.0.1:3200 没有响应，所以读不到配置与指标。" +
    "在项目根目录双击 start-all.cmd 会同时拉起两个服务；也可以手动执行下面的命令。",
  command: AGENT_START_COMMAND,
};

/**
 * 把一次失败归到具体原因。
 *
 * status 传 undefined 表示请求根本没发出去（fetch 抛异常 / 网络中断），
 * 这种情况和 502 一样按「服务不可达」处理——对用户来说要做的事是一样的。
 */
export function classifyAgentFailure(status?: number, message?: string): AgentFailure {
  if (status === undefined || status === 502 || status === 503 || status === 504) {
    return OFFLINE;
  }

  if (status === 401) {
    return {
      kind: "unauthorized",
      title: "登录状态已失效",
      detail: "刷新页面重新登录 CRM 后再试。",
    };
  }

  if (status === 403) {
    return {
      kind: "forbidden",
      title: "当前账号没有这项权限",
      detail: message || "Agent 控制面板只对系统管理员开放，请联系管理员调整角色权限。",
    };
  }

  if (status >= 500) {
    return {
      kind: "server",
      title: "Agent 服务内部出错",
      detail: message || `服务返回 ${status}，请查看 agent 终端日志排查。`,
    };
  }

  return {
    kind: "unknown",
    title: "请求没有成功",
    detail: message || `服务返回 ${status}，请稍后重试或查看 agent 终端日志。`,
  };
}

/** 聊天气泡里用的 Markdown 版本（AI 助手页） */
export function failureToMarkdown(failure: AgentFailure): string {
  const lines = [failure.title, "", failure.detail];
  if (failure.command) {
    lines.push("", "```bash", failure.command, "```");
  }
  return lines.join("\n");
}

/** 是否为「后端未启动」——前端据此决定要不要显示整块的排障卡片 */
export function isOffline(failure: AgentFailure | null): boolean {
  return failure?.kind === "offline";
}
