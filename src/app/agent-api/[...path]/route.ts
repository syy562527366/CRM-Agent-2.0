import { NextRequest, NextResponse } from "next/server";
import { authenticate, readToken } from "@/lib/auth/session";
import type { CrmScope } from "@/lib/crm/scope";

/**
 * Agent 服务反向代理（替代 next.config.ts 里那条公开 rewrite）。
 *
 * 旧做法把 `/agent-api/*` 直接 rewrite 到 127.0.0.1:3200，等于谁都能调、
 * 也拿不到调用者是谁。这里改成 Route Handler：
 *
 * 1. 先用签名会话确认「谁在调用」，未登录直接 401，不再转发；
 * 2. 把身份编码进 `x-crm-context`，把会话 token 放进 `x-crm-token`，
 *    两者都是服务端写入，浏览器和模型都无法伪造；
 * 3. 原样透传响应体（SSE 需要边收边发，不能 await 整个 body）。
 *
 * Agent 侧拿到头之后：
 *   - 用 `x-crm-context` 判断权限与数据范围，把身份放进 RunnableConfig；
 *   - 调 CRM 接口时带上 `Authorization: Bearer <x-crm-token>`，
 *     让 API 再做一次校验，形成双保险。
 */

const AGENT_SERVICE_URL = (process.env.AGENT_SERVICE_URL ?? "http://127.0.0.1:3200").replace(
  /\/+$/,
  "",
);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = Promise<{ path: string[] }>;

/** 调用者身份。HTTP 头只能放 ASCII，中文姓名走 base64url 编码进 context */
function identityHeaders(scope: CrmScope, token: string): Record<string, string> {
  const payload = {
    uid: scope.accountId,
    name: scope.name,
    roleId: scope.roleId,
    roleName: scope.roleName,
    permissions: (scope.role?.permissions ?? []).map((item) => ({
      pageKey: item.pageKey,
      functions: item.functions,
      dataScope: item.dataScope,
    })),
  };

  return {
    "x-crm-user": scope.accountId,
    "x-crm-token": token,
    "x-crm-context": Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url"),
  };
}

/** 请求体不是合法 JSON 对象时返回 null，由上游自己报错，代理不擅自改写 */
function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

async function handle(request: NextRequest, { params }: { params: Params }) {  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const { path } = await params;
  const segments = path ?? [];

  // 会话索引按调用者过滤：即使前端传了别人的 user_id 也无法越权列出
  const target = new URL(`${AGENT_SERVICE_URL}/${segments.map(encodeURIComponent).join("/")}`);
  request.nextUrl.searchParams.forEach((value, key) => {
    if (key === "user_id") return;
    target.searchParams.set(key, value);
  });
  if (segments[0] === "sessions" && !segments[1]) {
    target.searchParams.set("user_id", auth.scope.accountId);
  }

  // chat 请求体只有几百字节，整体读取比流转发更稳（流转发在部分代理层会挂住）
  const method = request.method;
  let body = method === "GET" || method === "HEAD" ? undefined : await request.text();

  // 请求体里的 user_id 一律以服务端身份为准：
  // 否则前端（或改过前端的客户端）可以把会话记到别人名下。
  if (body) {
    const payload = parseObject(body);
    if (payload && "user_id" in payload) {
      payload.user_id = auth.scope.accountId;
      body = JSON.stringify(payload);
    }
  }

  const headers: Record<string, string> = {
    accept: request.headers.get("accept") ?? "application/json",
    ...identityHeaders(auth.scope, readToken(request) ?? ""),
  };
  if (body) headers["content-type"] = "application/json";

  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers, body, cache: "no-store" });
  } catch {
    // 502 是留个「传输层失败」的准确语义，附带 code / hint 供前端做可读提示：
    // 光看 HTTP 502 分不清是没登录、没权限，还是后端进程根本没开。
    return NextResponse.json(
      {
        error: "Agent 服务未启动或不可达（默认 127.0.0.1:3200）",
        code: "AGENT_UNAVAILABLE",
        hint: "在项目根目录双击 start-all.cmd，或执行：cd agent && .venv\\Scripts\\python.exe app.py",
      },
      { status: 502 },
    );
  }

  // 只透传与流式渲染相关的头；content-length / content-encoding 交给 Next 重新计算
  const responseHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
  responseHeaders.set("cache-control", "no-cache, no-transform");
  responseHeaders.set("x-accel-buffering", "no");

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function GET(request: NextRequest, ctx: { params: Params }) {
  return handle(request, ctx);
}

export async function POST(request: NextRequest, ctx: { params: Params }) {
  return handle(request, ctx);
}

export async function PUT(request: NextRequest, ctx: { params: Params }) {
  return handle(request, ctx);
}

export async function PATCH(request: NextRequest, ctx: { params: Params }) {
  return handle(request, ctx);
}

export async function DELETE(request: NextRequest, ctx: { params: Params }) {
  return handle(request, ctx);
}
