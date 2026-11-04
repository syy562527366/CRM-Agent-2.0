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
| GET | `/health` | 健康检查，返回模型 ID、**实际可用工具**（已按控制面板过滤）、运行时长与配置版本 |
| GET | `/tools` | 已注册工具 |
| GET | `/config` | Agent 配置：系统提示词 + 工具开关 + 工具权限（**仅管理员**） |
| PUT | `/config` | 部分更新：`{"system_prompt"? , "tools"?: {名字: {enabled, permission}}}`（**仅管理员**） |
| POST | `/config/reset` | 恢复出厂配置（**仅管理员**） |
| POST | `/config/test-model` | 发一次最小请求测模型连通性，返回延迟与 token（**仅管理员**） |
| GET | `/metrics/overview?days=7` | 调用指标：今日 / 昨日 / 7 日趋势 / 工具榜（**仅管理员**） |
| GET | `/whoami` | 回显代理注入的调用者身份（排查 `x-crm-*` 头是否透传） |
| GET | `/sessions?user_id=` | 会话列表（按最近活跃时间倒序，默认不含空会话） |
| POST | `/sessions` | 新建会话：`{"user_id": "..."}`，同时清理该用户无对话的空会话 |
| PATCH | `/sessions/{id}` | 重命名会话：`{"title": "..."}` |
| DELETE | `/sessions/{id}` | 删除会话，连同对话记录（checkpoint）一起清掉 |
| GET | `/threads/{thread_id}` | 某会话历史，已压成前端气泡结构（`user` / `agent` + `tools`），并带 `pending_approval`（待审批） |
| POST | `/chat` | 同步对话：`{"message": "...", "thread_id": "demo", "user_id": "..."}` |
| POST | `/chat/stream` | SSE 流式，逐 token 推送；修改类工具会推 `approval_required` + `paused` |
| POST | `/chat/resume` | 人工审批后恢复执行：`{"thread_id", "decisions": [{"type":"approve"|"reject", "message"}]}` |

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
| `crm_update_lead` | 改线索的状态 / 优先级 / 负责人 / 意向产品 / 预算 / 定位 / 试用时长 / 备注。**每次调用都要人工审批** | `leads.修改` |
| `crm_update_order` | 调订单金额（正数校验，变动 ≥50% 会给出警告）。**每次调用都要人工审批** | `orders.修改` |
| ~~`crm_delete_lead`~~ | **不注册给模型**（Agent 无删除能力）；实现保留，入口直接 `FORBIDDEN` 并留痕 | `leads.删除` |
| ~~`crm_delete_order`~~ | 同上 | `orders.删除` |

CRM 工具统一走 HTTP 调 CRM 的 `/api/*`，**不再直读 `data/*.json`**：权限、数据范围、脱敏只在 CRM 侧实现一次，换存储不用动工具代码。返回统一信封：

```json
{"ok": true, "total": 20, "returned": 3, "truncated": true, "items": [...]}
{"ok": false, "error": "PERMISSION_DENIED", "message": "当前账号没有「orders」的查看权限…"}
```

`PERMISSION_DENIED` 在提示词里明确要求如实转述、不得绕过。

系统提示词约定：写线索分析结论时，额外输出一个 ```lead-analysis-card 代码块（JSON），前端会把它渲染成结构化卡片，而不是代码块。

## 写操作（只能修改，不能删除）

**Agent 不提供删除能力**：`crm_delete_lead` / `crm_delete_order` 不注册进 `TOOLS`，
即使被重新注册，函数入口也有 `AGENT_DELETE_ENABLED = False` 兜底，直接返回 `FORBIDDEN` 并写审计。
删除只能在 CRM 列表页由人工完成。

`tools_crm_write.py` 里的写工具同样是 HTTP 调 CRM，但多了三层保护：

1. **白名单补丁**：CRM 的 `PUT` 是 `{...old, ...body}` 全量覆盖，直接把模型给的 body 转发过去，
   模型就能顺手改 `id` / `createdAt` / `communicationCount`。因此只有 `_LEAD_PATCH` / `_ORDER_PATCH`
   里声明的字段能被写入，其余一律丢弃。
2. **先读后写**：每次写之前先 `GET` 原记录 —— 既确认在当前账号的数据范围内（别人的记录会 404），
   也拿到 before 快照，返回 `changed: [{field, before, after}]` 让前端渲染「字段/原值/新值」卡片。
3. **删除留底**：删之前把整条记录写进 `agent/data/trash.jsonl`（含操作人、原因、原始 row），
   误删可人工回捞；所有写操作无论成败都追加 `agent/data/audit.jsonl`（谁、哪个工具、改了什么、何时）。

定位目标记录支持两种写法：编号（`LD-2026-0002` / `ORD-20240105001`）或姓名。
姓名匹配到多条时返回 `AMBIGUOUS` + 候选列表，提示词要求模型把候选列给用户选，**禁止自行挑一条或原样重试**。

写工具的权限位是**修改**而不是查看：销售角色只有 `leads.修改` 时才能改，权限不足会返回
`PERMISSION_DENIED`；即便绕过本地判断，CRM API 也会用 Bearer token 再校验一次。

提示词层面还有一条「说清代价再动手」：转移负责人前先用一句话说明影响（转走你可能看不到）；
含糊指令（「把没用的清理一下」）必须先列候选等用户确认。

## Agent 控制面板（配置与指标）

前端页面 `/agent-settings`，后端配套 `/config` 与 `/metrics/overview`。三样东西都可配：

| 配置 | 存放 | 生效方式 |
|---|---|---|
| 系统提示词 | `agent/data/agent_config.json` 的 `system_prompt` | 覆盖 `prompts.SYSTEM_PROMPT`（出厂默认），下一次构建 agent 生效 |
| 工具开关 | 同文件 `tools.<name>.enabled` | 关掉的工具**不注册给模型**，`/health` 的 `tools` 立刻少一个 |
| 工具权限 | 同文件 `tools.<name>.permission` | `direct` 直接执行 / `approval` 进 `interrupt_on` / `forbidden` 同关闭 |

实现要点：

- `agent_config.py` 用 `REGISTRY` 做白名单，配置里出现未知工具直接 400，不做「静默忽略」；
- **删除类工具锁死**：`locked=True`，无论配置怎么写都强制 `enabled=false / permission=forbidden`，
  与 `tools_crm_write.AGENT_DELETE_ENABLED` 形成双重拦截；
- 写入用「临时文件 + `os.replace`」原子替换，不会出现半截 JSON 把服务打挂；
- 配置指纹（`revision`）参与 agent 缓存键：`@lru_cache _build_agent(workspace, revision)`，
  改完配置下一次提问就是新实例，进行中的请求不受影响；
- 接口一律 `can_manage(ctx)` 判定（「账号管理 → 修改」功能位），
  前端隐藏入口只是体验，**后端才是边界**；
- 断言兜底：`tools_guard` 里 `assert AGENT_DELETE_ENABLED is False`，防止有人图省事直接打开删除。

指标落在 `agent/data/agent.db` 的 `chat_metrics` 表（与会话、checkpoint 同库）：

| 列 | 含义 |
|---|---|
| `duration_ms` | 请求进入到 SSE 结束的墙钟时间 |
| `prompt_tokens` / `completion_tokens` / `total_tokens` | 取自模型 `usage_metadata`；流式按消息 id 取最大值，避免累计值被重复相加 |
| `tool_calls` / `tools` | 本轮工具调用个数与工具名（JSON 数组，用于控制面板的工具榜） |
| `ok` / `error` | 失败也记一条，控制面板能看出「今天错了几轮」 |
| `entry` | `chat`（新消息）或 `resume`（审批后继续），两者各算一次调用 |

## 人工审批（修改类操作）

修改类工具走框架自带的 `interrupt_on`（底层 langchain `HumanInTheLoopMiddleware`），
策略集中在 `tools_guard.py`：

| 操作 | 策略 |
|---|---|
| 查询（7 个只读工具 + calculator / get_current_time） | 不拦，直接执行 |
| 修改（`crm_update_*`） | 暂停 → 前端弹审批卡 → 批准才执行，拒绝则工具不跑 |
| 删除 | 工具不注册 + 入口 `FORBIDDEN`，双重拦截 |

一轮流程：

```
POST /chat/stream        → SSE: ... token/tool ... → {"type":"approval_required", actions:[...]}
                            → {"type":"paused"}    （不是结束，是等人）
POST /chat/resume        → {"thread_id","decisions":[{"type":"approve"}]} → 继续流式输出
                            decisions 顺序必须与 actions 的 index 一一对应（batched 模式按下标匹配）
```

要点：

- 中断状态存在 `SqliteSaver` 里，进程重启后仍可继续批；
- `GET /threads/{id}` 返回 `pending_approval`，切走会话 / 刷新回来能恢复审批卡；
- pending 状态下同一 thread 发新消息会被挡下（`guard.PENDING_MESSAGE`），前端同时锁输入框；
- 批准与否都写 `agent/data/audit.jsonl`（`action: "approval"`，含 `decision` / `reason` / `approved_by`）；
- **审批不能替代权限**：批准后工具内部仍会校验权限位、数据范围与字段白名单。

> 坑：`agent.stream(stream_mode=["messages","updates"])` 里 `__interrupt__` 的值是 `tuple`，
> 老的循环 `if not isinstance(delta, dict): continue` 会把它静默丢掉，表现为「卡住、无回复、无报错」。
> `app._stream_events` 现在先判 `__interrupt__` 再判类型。

> CRM dev server 的一个坑：同一个 keep-alive 连接上第二次发非 GET 请求，Next dev（16.2.9 Turbopack）
> 会回 308 且 `Location` 指向同一个 URL。`CrmClient` 因此固定 `Connection: close` 且不复用连接，
> 同时对 307/308 做一次原样重试兜底。

`thread_id` 相同即同一会话。对话状态落在 SQLite（`agent/data/agent.db`，`SqliteSaver`），**进程重启不丢**；会话列表另存在同库的 `sessions` 表（标题取首条提问，轮数取提问次数）。
注意：`tool_data` 卡片是实时 SSE 推送的，**不进对话历史**，刷新或切回旧会话时只有文字与工具调用行。

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

写操作单独一套（不经大模型，直接调工具函数，需要 CRM 在 3100 运行）：

```bash
agent/.venv/Scripts/python.exe agent/test_write_tools.py
```

覆盖 28 项：修改线索（多字段 / 落盘 / 还原 / 空参数 / 非法枚举 / 编号不存在 / 重名歧义不改数据）、
修改订单（金额 / 越界 / 还原）、删除线索与订单（落盘核对 + 404 校验 + 卡片）、
权限（销售无删除权 / 销售可改 / 无身份）、审计与留底。脚本自己造数据并清理，跑完线索数不变。
当前 28/28 通过。

## 结构

```
agent/
├── app.py              FastAPI 服务 + deep agent 构建（create_deep_agent）
├── tools.py            通用工具：calculator / get_current_time
├── tools_crm.py        CRM 只读工具 7 个（走 HTTP API）
├── tools_crm_write.py  CRM 写工具 4 个：改线索 / 改订单 / 删线索 / 删订单
├── crm_client.py       身份解析（x-crm-context）+ CRM API 客户端 + 错误映射
├── test_agent.py       冒烟测试（7 项，含模型调用）
├── test_write_tools.py 写操作测试（28 项，直调工具函数，自动清理数据）
├── requirements.txt
├── workspace/          每个账号一个子目录（FilesystemBackend 的真实落点，已 gitignore）
├── data/agent.db       对话状态 + 会话索引（SQLite，已 gitignore）
├── data/audit.jsonl    写操作审计日志（已 gitignore）
├── data/trash.jsonl    删除前的记录留底（已 gitignore）
└── .env                API Key、Base URL、模型 ID（已 gitignore）
```

deep agent 自带 todo 拆解、文件系统、subagent 能力，这里只替换了 backend，没有再额外叠加 middleware。

## 已知限制

- 会话存储在单机 SQLite，多实例部署需要换 Postgres / Redis checkpointer。
- 文件系统只在 `agent/workspace/<账号ID>/` 内活动，不提供 shell 执行能力（`execute` 工具会报错）。
- 写操作已接 `interrupt_on` 人工审批（2026-11-04），删除能力已关闭；配置缓存键已带上 `revision`，
  后续若要按角色裁剪工具（L1），记得把 `role_id` 也拼进缓存键，否则不同角色会共用同一个 agent 实例。
- 控制面板的指标是「按进程内 SQLite 累加」，多实例部署需要换成共享库或上报到监控系统。
- `tool_data` 卡片不持久化，历史会话里只剩文字和工具行。
- 会话归属依赖 Next 代理注入的 `user_id` / 身份头；绕过代理直连 3200 端口时没有鉴权，生产部署需把端口限制在 127.0.0.1。
