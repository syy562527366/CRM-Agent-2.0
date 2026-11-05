# CRM Agent 1.0

CRM 客户管理平台 + 本地 AI Agent 服务。前端跑一套完整的多角色 CRM，后端接一个基于 deepagents 的
Agent 服务，能用自然语言查线索、看统计、改订单，写操作走人工审批。

基础 CRM 业务功能

## 功能

- 数据仪表盘（chart.js 图表）
  - 全部指标读 `GET /api/stats?domain=overview` 一次算完（成交额 / 新增线索 / 订单 / 转化率 /
    30 天趋势 / 漏斗 / 来源 / 商品 / 销售排行），没有硬编码数据；月份对比用「本月至今 vs 上月同期」
- 线索管理 / 商品管理 / 订单管理
  - 商品目录由 2022-2026 合同汇总表导入（21 个在售服务，含类别 / 单位 / 成交统计），
    种子规则见 `docs/product-catalog-import.md`，可重复执行 `scripts/import-products.py`
  - 订单按「成交线索」开出（客户、电话、商品直接取自线索，金额取预算区间中值），
    可重复执行 `scripts/seed-orders.py`
  - 列表统一每页 10 条
- 账号管理 / 角色与权限（页面权限 + 功能权限 + 数据范围）
- 沟通记录
- 手机号 + 密码登录

## 技术栈

- Next.js 16.2.9（Turbopack）+ React 19.2 + Tailwind 4 + chart.js
- 数据层：JSON 文件存储（`data/*.json`），访问逻辑集中在 `src/lib/crm/*`（API 路由与 Agent 共用）
- 鉴权：HMAC-SHA256 签名会话 + HttpOnly Cookie，`src/lib/auth/session.ts`
- **无外部后端服务**，单进程运行

## 快速启动

```bash
npm install
cp .env.example .env.local   # 生产环境请替换 CRM_SESSION_SECRET
npm run dev        # http://127.0.0.1:3100
```

默认账号：`13912345678` / 密码 `123123`（见 `data/accounts.json`）

### AI 助手（可选，需另起 Agent 服务）

侧边栏「智能助手 → AI 助手」(`/agent`) 对接本地 DeepAgents 服务，需先启动 Python 端：

```bash
cd agent && ./.venv/Scripts/python.exe app.py   # http://127.0.0.1:3200
```

Windows 下也可以直接双击项目根目录的 **`start-all.cmd`**，它会为 CRM 和 Agent 各开一个窗口，两个窗口都保持打开即可（关掉窗口等于停服务）。

前端通过 `src/app/agent-api/[...path]/route.ts` 这个 Route Handler 反向代理到该服务（默认 `http://127.0.0.1:3200`，可用环境变量 `AGENT_SERVICE_URL` 覆盖）：未登录直接 401 且不转发，登录后注入 `x-crm-user` / `x-crm-token` / `x-crm-context` 三个身份头，Agent 侧据此按当前账号的权限和数据范围取数。Agent 未启动时请求返回 502（附 `code: AGENT_UNAVAILABLE` 与启动命令），页面会给出排障卡与「重新检测」入口；其余 CRM 功能不受影响。

## 目录结构

```
src/app/           页面路由（agent/dashboard/leads/products/orders/accounts/roles/communications/login）
src/app/api/       API 路由（auth/accounts/leads/orders/products/roles/communications/stats）
src/components/    业务组件（AgentChat 为 AI 助手对话界面，SessionPanel 为会话管理栏，chat/ 为对话原子组件）
src/hooks/         usePermission 权限判断
src/lib/crm/       数据访问层（JSON 读写、检索、按数据范围过滤）—— API 与 Agent 的唯一数据出口
src/lib/auth/      会话签名（HMAC-SHA256）与鉴权助手
src/types/         类型定义
data/              JSON 数据文件（业务数据 + 账号 + 角色 + 销售目标）
agent/             DeepAgents + DeepSeek 的 Python Agent 服务（独立 venv）
```

## 鉴权与数据权限

- 登录成功后服务端签发 HMAC 签名的会话 token，同时写入 **HttpOnly Cookie**（12 小时有效）。前端 fetch 无需任何改造，浏览器自动携带。
- 每个 API 路由在入口调用 `authorize(request, pageKey, action)`，依次校验：会话有效 → 账号存在 → 角色具备该页面的对应功能权限；无权限返回 `403`，未登录返回 `401`。
- 数据范围「仅自己」在数据层强制注入过滤条件（线索按 `assignee === 当前账号姓名`，沟通记录按本人线索 ID），工具与路由都无法绕过。
- `GET /api/auth/session` 返回当前账号与最新角色权限，前端启动时用它校验会话并同步权限；会话失效会自动退回登录页。
- 修改密码只允许改自己的（管理员另需「账号 · 修改」权限），且始终校验原密码。

## 数据文件

`accounts.json` / `leads.json` / `products.json` / `orders.json` / `roles.json` / `communications.json` / `sales-targets.json`

## AI 助手实现要点

- 对话流：`POST /agent-api/chat/stream`（SSE），服务端按 token 推送，前端打字机渲染；`thread_id` 维持多轮上下文。
- 消息布局：用户消息右侧蓝色气泡，Agent 左侧白底气泡，两者各带头像；正文走 `react-markdown` + `remark-gfm`（表格带斑马纹与悬浮高亮、代码块带语言角标与「复制」按钮、引用块带主色左边线）。
- 工具调用面板：Agent 气泡上方以可折叠面板展示每次工具调用，六态配色（执行中蓝 / 完成绿 / 失败红 / 待审批黄 / 已批准绿 / 已拒绝红），展开可见工具用途、参数与返回值；并发工具按 `tool_call_id` 精确配对。
- 人工审批卡：修改类工具（`crm_update_lead` / `crm_update_order`）调用后暂停，弹出审批卡展示「改哪条、改什么」，批准才落库、拒绝则不执行；删除能力对 Agent 关闭。
- Agent 控制面板（`/agent-settings`，仅管理员）：概览页展示服务健康、模型连通性、今日调用次数、平均响应耗时、工具调用次数与 Token 消耗（含 7 日趋势与工具榜）；配置页可修改系统提示词、逐个开关工具、把工具权限设为「直接使用 / 人工审批 / 禁止」，保存后下一次提问即生效。
- 线索分析卡片：Agent 输出 ```lead-analysis-card 代码块时渲染为结构化卡片（姓名、意向等级、预算、竞品提及、建议动作），数据来自 `crm_get_lead` 等只读工具。
- 空状态：机器人图标 + 模型与工具能力徽章 + 4 条 CRM 场景引导问句，点击即发送。
- 组件拆分：`src/components/chat/` 下 Atoms（头像/图标/徽章）、ToolPanel、MarkdownRenderer、LeadAnalysisCard，全部内联样式 + `globals.css` 类，零 Tailwind 依赖。
- 输入框：Enter 发送、Shift + Enter 换行；中文输入法组合态（`isComposing` / `keyCode 229` / 组合结束后 150ms 内）按 Enter 不会误发送。
- 会话管理栏（左侧）：顶部固定「创建会话」，下方按时间倒序展示历史会话；悬浮条目显删除按钮，**单击即删除**（同时移除服务端记录与 checkpoint）；点击条目加载该会话历史；收起后由详情页顶栏最左侧的「展开」按钮恢复，折叠状态存 `localStorage`。
- 会话列表与历史消息来自 Agent 服务的 `/sessions`、`/threads/{id}`，历史消息与实时消息共用同一份 `messages` 状态和同一套气泡渲染。
- 权限：页面 key 为 `agent`，在「角色与权限」中按角色配置访问权（默认管理员、销售均可查看）。


## 数据构建脚本

业务数据都由脚本生成，可重复执行、不会产生重复记录（各脚本先清自己写过的号段再重建）：

| 脚本 | 作用 |
|---|---|
| `scripts/import-products.py` | 从 2022-2026 合同汇总表导入商品目录（21 个在售服务），含类别 / 单位 / 参考价 / 成交统计 |
| `scripts/seed-leads.py` | 生成碳核算业务线索与配套沟通记录，状态与跟进节奏挂钩，意向产品取自商品目录 |
| `scripts/seed-orders.py` | 按「成交线索」开单，客户 / 电话 / 商品取自线索，金额取预算区间中值 |
| `scripts/rename-assignees.py` | 一次性迁移：把演示销售名换成项目汇总表里的真实负责人 |
| `scripts/xlsx_read.py` | 纯标准库 xlsx 读取器（zipfile + XML），用于在没有 openpyxl 的环境解析源表 |

## 来源与致谢

本项目在 [songduo/CRM-V3-AgentBase](https://github.com/songduo/CRM-V3-AgentBase) 的基础上继续开发，
保留了原有的 CRM 页面骨架、鉴权与权限模型；在此基础上新增：

- 数据仪表盘改读真实聚合（`GET /api/stats?domain=overview`），删除全部硬编码 mock
- 商品目录、线索、订单三套数据从真实合同汇总表重建，并提供可重跑脚本
- Agent 工具三档权限（查询直通 / 修改人工审批 / 删除禁用）与审批卡片
- Agent 控制面板（`/agent-settings`）：提示词、工具开关、三态权限、运行指标
- Agent 服务不可用时的排障卡与统一失败判定
