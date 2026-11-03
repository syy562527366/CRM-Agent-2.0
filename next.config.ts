import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // 允许通过 127.0.0.1 / localhost 访问 dev 资源，避免预览面板白屏（Next.js 16 dev 安全策略）
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // 注意：/agent-api/* 不再用 rewrites。rewrite 无法先校验登录态，
  // 现在由 src/app/agent-api/[...path]/route.ts 代理，并在转发头里注入调用者身份。
};

export default nextConfig;
