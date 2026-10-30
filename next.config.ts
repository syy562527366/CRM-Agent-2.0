import type { NextConfig } from "next";

// DeepAgents 服务地址（Python FastAPI，默认 3200），可用环境变量覆盖
const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL ?? "http://127.0.0.1:3200";

const nextConfig: NextConfig = {
  devIndicators: false,
  // 允许通过 127.0.0.1 / localhost 访问 dev 资源，避免预览面板白屏（Next.js 16 dev 安全策略）
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // 把 /agent-api/* 反向代理到 Agent 服务，避免浏览器跨域，也便于统一出口
  async rewrites() {
    return [
      {
        source: "/agent-api/:path*",
        destination: `${AGENT_SERVICE_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
