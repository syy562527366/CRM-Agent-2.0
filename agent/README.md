# DeepAgent 服务（deepagents + DeepSeek）

基于 [langchain-ai/deepagents](https://github.com/langchain-ai/deepagents) 的最小可用 Agent 服务，模型走 DeepSeek 的 OpenAI 兼容接口（`langchain-deepseek`）。

## 环境

| 项 | 值 |
|---|---|
| Python | 3.13.12（项目内 venv：`agent/.venv`） |
| deepagents | 0.7.32（官方 PyPI 包，未拉 375MB 的整仓源码，也不需要 deepagents-code） |
| langchain / langgraph | 1.4.7 / 1.2.18 |
| langchain-deepseek | 1.1.1 |
| langgraph-checkpoint-sqlite | 3.1.2（会话持久化） |
| 服务端口 | 3200 |

## 模型名说明（重要）

DeepSeek 平台控制台显示名是 **DeepSeek-V4.1-Flash**，但接口只认模型 ID：

- ✅ `deepseek-flash` = DeepSeek-V4.1-Flash（本项目使用）
- ✅ `deepseek-v4-pro` = DeepSeek-V4-Pro
- ❌ `deepseek-v4.1-flash` → 服务端返回 `invalid_request_error: The supported API model names are deepseek-flash, deepseek-v4-pro`

模型 ID 配在 `agent/.env` 的 `DEEPSEEK_MODEL`，改这里即可切换。

## 启动

```bash
# 依赖（首次）
agent/.venv/Scripts/python.exe -m pip install -r agent/requirements.txt \
  -i https://mirrors.aliyun.com/pypi/simple/

# 启动服务
cd agent && ./.venv/Scripts/python.exe app.py
# 等价写法：agent/.venv/Scripts/python.exe -m uvicorn app:app --app-dir agent --port 3200
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，返回模型 ID、工具列表与存储类型 |
| GET | `/tools` | 已注册工具 |
| GET | `/whoami` | 回显代理注入的调用者身份（排查 `x-crm-*` 头是否透传） |
| GET | `/sessions?user_id=` | 会话列表（按最近活跃时间倒序，默认不含空会话） |
| POST | `/sessions` | 新建会话：`{"user_id": "..."}`，同时清理该用户无对话的空会话 |
| PATCH | `/sessions/{id}` | 重命名会话：`{"title": "..."}` |
| DELETE | `/sessions/{id}` | 删除会话，连同对话记录（checkpoint）一起清掉 |
| GET | `/threads/{thread_id}` | 某会话历史，已压成前端气泡结构（`user` / `agent` + `tools`） |
| POST | `/chat` | 同步对话：`{"message": "...", "thread_id": "demo", "user_id": "..."}` |
| POST | `/chat/stream` | SSE 流式，逐 token 推送 |

`/chat/stream` 同时订阅 `messages`（逐 token 增量）与 `updates`（节点快照），事件类型为 `token` / `ai` / `tool` / `tool_data` / `session` / `error`；`tool` 事件带 `tool_call_id`，前端据此精确回填工具结果（并发工具返回顺序不定）。一轮结束后会推一条 `session` 事件，回传该会话的最新标题与轮数。

`tool_data` 用于把工具查到的明细交给前端渲染表格，**不写进模型上下文**，避免几十行数据反复占用 token。

CRM 前端「AI 助手」页（`/agent`）通过 Next 的 Route Handler `/agent-api/*` 代理到本服务。代理会先校验登录态，再把调用者身份写进请求头：

| 头 | 内容 |
|---|---|
| `x-crm-user` | 账号 ID |
| `x-crm-token` | 签名会话 token，工具调 CRM 接口时作为 `Authorization: Bearer` |
| `x-crm-context` | `base64url(JSON)`：`{uid, name, roleId, roleName, permissions[]}` |

身份只从这三个头来，**不占工具参数**——模型在 tool schema 里看不到，也无法伪造。

## 工具

| 工具 | 说明 | 依赖权限 |
|---|---|---|
| `calculator` | AST 安全求值四则运算，不执行 `eval`，除零等错误以「计算失败」文本返回 | — |
| `get_current_time` | 时区感知的当前时间（Windows 需装 `tzdata`，否则回退 `(local)`） | — |
| `crm_search_leads` | 按状态 / 优先级 / 来源 / 负责人 / 关键词 / 日期检索线索，返回摘要 | `leads.查看` |
| `crm_get_lead` | 单条线索详情，手机号与身份证做脱敏 | `leads.查看` |
| `crm_get_lead_timeline` | 某条线索最近的沟通记录 | `communications.查看` |
| `crm_search_orders` | 检索订单，返回摘要与金额合计 | `orders.查看` |
| `crm_list_products` | 在售商品与价格 | `products.查看` |
| `crm_lead_stats` | 线索分组计数（状态 / 来源 / 负责人 / 优先级） | `leads.查看` |
| `crm_sales_stats` | 销售统计（商品 / 负责人 / 月份，含成交额与客单价） | `orders.查看` |

CRM 工具统一走 HTTP 调 CRM 的 `/api/*`，**不再直读 `data/*.json`**：权限、数据范围、脱敏只在 CRM 侧实现一次，换存储不用动工具代码。返回统一信封：

```json
{"ok": true, "total": 20, "returned": 3, "truncated": true, "items": [...]}
{"ok": false, "error": "PERMISSION_DENIED", "message": "当前账号没有「orders」的查看权限…"}
```

`PERMISSION_DENIED` 在提示词里明确要求如实转述、不得绕过。

系统提示词约定：写线索分析结论时，额外输出一个 ```lead-analysis-card 代码块（JSON），前端会把它渲染成结构化卡片，而不是代码块。

`thread_id` 相同即同一会话。对话状态落在 SQLite（`agent/data/agent.db`，`SqliteSaver`），**进程重启不丢**；会话列表另存在同库的 `sessions` 表（标题取首条提问，轮数取提问次数）。

## 文件系统能力（FilesystemBackend）

已开通：`create_deep_agent(backend=FilesystemBackend(root_dir=..., virtual_mode=True))`。

- 真实落盘，重启不丢；默认根目录 `agent/workspace/<账号ID>/`，按账号隔离，A 的文件 B 看不到；
- `virtual_mode=True` 把该目录当虚拟根，`/../.env` 这类路径穿越会被直接拒绝；
- 因此 agent 的 `ls` / `read_file` / `write_file` 可用，但读不到 `agent/.env`、项目 `data/*.json`；
- 该目录已 gitignore。

## 测试

服务启动后：

```bash
agent/.venv/Scripts/python.exe agent/test_agent.py
```

覆盖 7 项：健康检查、基础问答、calculator 工具调用、多轮记忆、会话历史、身份头解析、CRM 工具调用。当前 7/7 通过，约 8 秒。

## 结构

```
agent/
├── app.py            FastAPI 服务 + deep agent 构建（create_deep_agent）
├── tools.py          通用工具：calculator / get_current_time
├── tools_crm.py      CRM 只读工具 7 个（走 HTTP API）
├── crm_client.py     身份解析（x-crm-context）+ CRM API 客户端 + 错误映射
├── test_agent.py     冒烟测试
├── requirements.txt
├── workspace/        每个账号一个子目录（FilesystemBackend 的真实落点，已 gitignore）
├── data/agent.db     对话状态 + 会话索引（SQLite，已 gitignore）
└── .env              API Key、Base URL、模型 ID（已 gitignore）
```

deep agent 自带 todo 拆解、文件系统、subagent 能力，这里只替换了 backend，没有再额外叠加 middleware。

## 已知限制

- 会话存储在单机 SQLite，多实例部署需要换 Postgres / Redis checkpointer。
- 文件系统只在 `agent/workspace/<账号ID>/` 内活动，不提供 shell 执行能力（`execute` 工具会报错）。
- 未启用人工审批（`interrupt_on`），有副作用的工具（写 CRM）上线前必须打开。
- 会话归属依赖 Next 代理注入的 `user_id` / 身份头；绕过代理直连 3200 端口时没有鉴权，生产部署需把端口限制在 127.0.0.1。
