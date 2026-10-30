# CRM-V3-AgentBase（Song老师课程用CRM系统）
<img width="1920" height="878" alt="image" src="https://github.com/user-attachments/assets/b6aa9f81-9ac1-4596-8d65-9cbfdb602365" />

基础 CRM 业务功能

## 功能

- 数据仪表盘（chart.js 图表）
- 线索管理 / 商品管理 / 订单管理
- 账号管理 / 角色与权限（页面权限 + 功能权限 + 数据范围）
- 沟通记录
- 手机号 + 密码登录

## 技术栈

- Next.js 16.2.9（Turbopack）+ React 19.2 + Tailwind 4 + chart.js
- 数据层：JSON 文件存储（`data/*.json`），Next.js API Routes 读写
- **无后端服务**，单进程运行

## 快速启动

```bash
npm install
npm run dev        # http://127.0.0.1:3100
```

默认账号：`13912345678` / 密码 `123123`（见 `data/accounts.json`）

### AI 助手（可选，需另起 Agent 服务）

侧边栏「智能助手 → AI 助手」(`/agent`) 对接本地 DeepAgents 服务，需先启动 Python 端：

```bash
cd agent && ./.venv/Scripts/python.exe app.py   # http://127.0.0.1:3200
```

前端通过 `next.config.ts` 的 rewrite 把 `/agent-api/*` 反向代理到该服务（默认 `http://127.0.0.1:3200`，可用环境变量 `AGENT_SERVICE_URL` 覆盖），因此浏览器端不涉及跨域。Agent 未启动时页面顶部状态点会变红并提示"服务未连接"，其余 CRM 功能不受影响。

## 目录结构

```
src/app/           页面路由（agent/dashboard/leads/products/orders/accounts/roles/communications/login）
src/app/api/       API 路由（auth/accounts/leads/orders/products/roles/communications）
src/components/    业务组件（AgentChat 为 AI 助手对话界面）
src/hooks/         usePermission 权限判断
src/types/         类型定义
data/              JSON 数据文件（业务数据 + 账号 + 角色 + 销售目标）
agent/             DeepAgents + DeepSeek 的 Python Agent 服务（独立 venv）
```

## 数据文件

`accounts.json` / `leads.json` / `products.json` / `orders.json` / `roles.json` / `communications.json` / `sales-targets.json`

## AI 助手实现要点

- 对话流：`POST /agent-api/chat/stream`（SSE），服务端按 token 推送，前端打字机渲染；`thread_id` 维持多轮上下文。
- 消息布局：用户消息右侧蓝色气泡，Agent 左侧白底气泡，正文走 `react-markdown` + `remark-gfm`（支持表格、列表、代码块）。
- 工具调用轨迹：Agent 气泡顶部以小标签展示调用了哪些工具（名称 + 参数），悬停可见返回值。
- 输入框：Enter 发送、Shift + Enter 换行；中文输入法组合态（`isComposing` / `keyCode 229` / 组合结束后 150ms 内）按 Enter 不会误发送。
- 权限：页面 key 为 `agent`，在「角色与权限」中按角色配置访问权（默认管理员、销售均可查看）。

