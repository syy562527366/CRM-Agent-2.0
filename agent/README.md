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
| GET | `/sessions?user_id=` | 会话列表（按最近活跃时间倒序，默认不含空会话） |
| POST | `/sessions` | 新建会话：`{"user_id": "..."}`，同时清理该用户无对话的空会话 |
| PATCH | `/sessions/{id}` | 重命名会话：`{"title": "..."}` |
| DELETE | `/sessions/{id}` | 删除会话，连同对话记录（checkpoint）一起清掉 |
| GET | `/threads/{thread_id}` | 某会话历史，已压成前端气泡结构（`user` / `agent` + `tools`） |
| POST | `/chat` | 同步对话：`{"message": "...", "thread_id": "demo", "user_id": "..."}` |
| POST | `/chat/stream` | SSE 流式，逐 token 推送 |

`/chat/stream` 同时订阅 `messages`（逐 token 增量）与 `updates`（节点快照），事件类型为 `token` / `ai` / `tool` / `session` / `error`；`tool` 事件带 `tool_call_id`，前端据此精确回填工具结果（并发工具返回顺序不定）。一轮结束后会推一条 `session` 事件，回传该会话的最新标题与轮数。

CRM 前端「AI 助手」页（`/agent`）通过 Next rewrite `/agent-api/*` 代理到本服务，无需额外配置 CORS。

`thread_id` 相同即同一会话。对话状态落在 SQLite（`agent/data/agent.db`，`SqliteSaver`），**进程重启不丢**；会话列表另存在同库的 `sessions` 表（标题取首条提问，轮数取提问次数）。

## 测试

服务启动后：

```bash
agent/.venv/Scripts/python.exe agent/test_agent.py
```

覆盖 5 项：健康检查、基础问答、calculator 工具调用、多轮记忆、会话历史。当前结果 5/5 通过，约 5 秒。

## 结构

```
agent/
├── app.py            FastAPI 服务 + deep agent 构建（create_deep_agent）
├── tools.py          calculator / get_current_time 两个工具
├── test_agent.py     冒烟测试
├── requirements.txt
├── data/agent.db     对话状态 + 会话索引（SQLite，已 gitignore）
└── .env              API Key、Base URL、模型 ID（已 gitignore）
```

deep agent 默认自带 todo 拆解、虚拟文件系统、subagent 能力，这里没有再额外叠加 middleware。

## 已知限制

- 会话存储在单机 SQLite，多实例部署需要换 Postgres / Redis checkpointer。
- 未接真实文件系统（默认 StateBackend）；若要读写磁盘，用 `backend=FilesystemBackend(root_dir=...)`，Windows 下需注意 shell 能力受限，工具实现走纯 Python。
- 未启用人工审批（`interrupt_on`），有副作用工具上线前建议打开。
- 会话归属依赖前端传的 `user_id`，未做服务端鉴权（本地单用户场景够用，对外开放前需补）。
