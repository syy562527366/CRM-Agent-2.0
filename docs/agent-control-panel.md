# Agent 控制面板 —— 设计说明

> 目标：把 Agent 的「运行状态」与「行为边界」从代码里搬到一个页面上，让管理员不用改代码、
> 不用重启服务就能看到它跑得怎么样、允许它做什么。
> 页面：`/agent-settings`（仅系统管理员）。后端：`agent/agent_config.py` + `agent/metrics.py`。

## 一、页面结构

| 页签 | 内容 | 数据来源 |
|---|---|---|
| Agent 概览 | 服务健康、模型连通性、今日调用次数、平均响应耗时、工具调用次数、Token 消耗量；7 日趋势与工具使用排行 | `/health`、`/metrics/overview`、`/config/test-model` |
| 系统提示词 | 全文展示当前提示词，可编辑、可还原默认、可保存；显示字符数、上次更新时间与修改人 | `/config`、`PUT /config` |
| 工具与权限 | 13 个工具的开关 + 权限三态，删除类锁死；批量保存 | `/config`、`PUT /config` |

右侧固定「配置版本」，是配置指纹（`revision`）的前 12 位——看到它变化就知道配置真的落库并生效了。

## 二、配置模型

一份 JSON，落在 `agent/data/agent_config.json`（已 gitignore，属于运行时状态）：

```json
{
  "system_prompt": "你是……",
  "tools": {
    "crm_search_leads": { "enabled": true,  "permission": "direct" },
    "crm_update_lead":  { "enabled": true,  "permission": "approval" },
    "crm_delete_lead":  { "enabled": false, "permission": "forbidden" }
  },
  "updated_at": "2026-11-04T15:02:00+08:00",
  "updated_by": "系统管理员"
}
```

三档权限的实际含义：

| 权限 | 注册给模型 | 调用时 | 典型工具 |
|---|---|---|---|
| `direct` 直接使用 | ✅ | 立即执行 | 查询类、calculator、时间 |
| `approval` 人工审批 | ✅ | 暂停 → 审批卡 → 批准才执行 | `crm_update_lead` / `crm_update_order` |
| `forbidden` 禁止 | ❌ | 模型看不到，无从调用 | 删除类（锁死） |

「关掉开关」与「权限设为禁止」等效（都不注册），区别只在语义：开关表达「暂时不用」，
禁止表达「明确不允许」。重新打开开关时，权限会自动回到该类工具的默认值
（修改类回「人工审批」，而不是「直接使用」）——否则会出现「开关是开的、但其实没注册」的怪状态。

### 为什么删除类必须锁死

上一轮产品要求「禁止 Agent 删除数据」，已在三处设防：

1. 删除工具**不在** `app.TOOLS` 注册池里；
2. `tools_crm_write.AGENT_DELETE_ENABLED = False`，入口直接返回 `FORBIDDEN` 并写审计；
3. 配置层 `locked=True`，`save()` 里显式拒绝 `enabled=true` 或改权限，前端控件直接禁用。

三处是「冗余」而不是「重复」：任何一处被误改，另外两处仍能拦住。

## 三、生效链路

改配置不需要重启，靠配置指纹换 agent 实例：

```
PUT /config → agent_config.save() → atomic write → revision 变化
                                    ↓
下一次请求 get_agent(workspace) → _build_agent(workspace, revision)
                                    ↓
        tools=[t for t in TOOLS if t.name in enabled]
        system_prompt=cfg.current_prompt()
        interrupt_on=guard.build_interrupt_on(cfg.approval_tool_names())
```

- 旧实例留在 LRU（maxsize=32）里等待淘汰，**进行中的请求不受影响**；
- 配置没变时命中缓存，不会每次请求都重建 agent；
- 会话状态在 `SqliteSaver` 里，换实例不影响多轮上下文。

### 校验比宽容重要

配置是给人改的，必须挡在入口：

| 情况 | 处理 |
|---|---|
| 工具名不在 `REGISTRY` | 400「未知工具：xxx」，不静默忽略 |
| 权限值不在三档内 | 400 |
| 提示词短于 20 字符或超过 20000 字符 | 400（空提示词会让 Agent 完全失控） |
| 开启删除类 / 改删除类权限 | 400，带产品规则原文 |
| 文件被手改坏（非法 JSON） | 退回默认值，服务照常启动，面板显示默认配置 |

## 四、指标口径

写进 `chat_metrics` 表（`agent/data/agent.db`，与会话、checkpoint 同库，便于一起备份）。

| 指标 | 口径 | 容易误解的点 |
|---|---|---|
| 今日调用次数 | 一次 `/chat/stream` 或 `/chat/resume` 算一次 | 不是消息条数；审批后继续执行**单独**计一次 |
| 平均响应耗时 | 请求进入到 SSE 结束的墙钟时间 | 含工具调用与等待审批的时间，故写操作天然更慢 |
| P95 响应耗时 | 今日耗时排序后 95 分位 | 样本少时接近最大值 |
| 工具调用次数 | 本轮实际发起的工具调用个数 | 一次调多个工具（并发）会累加 |
| Token 消耗量 | 模型返回的 `usage_metadata` | 一轮里多次调模型会累加；流式按消息 id 取最大，避免累计值重复相加 |
| 失败轮数 | `ok=0` 的调用 | 前端断流（GeneratorExit）不计失败 |

流式 token 统计有个坑：DeepSeek 只在最后一块 chunk 带 `usage`，但不同版本可能每块都带且是累计值。
所以 `_track_usage` 按 `message.id` 归并、取最大值而不是相加——直接相加会把 token 放大好几倍。

## 五、权限

| 层 | 做法 | 说明 |
|---|---|---|
| 前端入口 | `canManageAgent(role)`：角色具备「账号管理 → 修改」才显示侧边栏项 | 只是体验 |
| 页面 | 无权限时渲染「无访问权限」说明，不请求配置接口 | 防止误以为页面坏了 |
| 后端 | `_require_admin(ctx)` 校验同一个功能位，否则 403 | **真正的边界** |
| 身份来源 | Next 代理写入的 `x-crm-context`，浏览器与模型都改不了 | 与工具权限同一套 |

为什么用「账号管理 → 修改」而不是角色名「管理员」：角色名是用户可以随便改的文本，
功能位才是稳定判据。销售角色没有 accounts 页面，自然进不来。

## 六、已验证

| 测试 | 覆盖 | 结果 |
|---|---|---|
| `agent/test_config.py` | 默认值、校验、开关/权限生效、原子写、恢复出厂、管理员门禁、指标聚合与跨天隔离 | 50/50 |
| 接口联调 | 无身份/销售 403、关工具后 `/health` 少一个、改提示词、非法输入 400、模型连通性、恢复出厂 | 17/17 |
| 真实对话 | 一次「现在几点」→ 指标记录 calls=1、tokens=12511、tool_calls=1、工具榜 `get_current_time` | 通过 |
| 浏览器 | 管理员看得到入口且能改配置并保存（版本号变化、`/health` 同步收缩）；销售看不到入口，直连 URL 显示无访问权限 | 通过 |

## 七、失败时的界面

Agent 后端是独立进程，挂掉时页面拿到的只有代理层的 502。为了别让用户对着
「配置读取失败（HTTP 502）」猜，失败原因统一由 `src/lib/agent/errors.ts` 定性：

| kind | 触发 | 界面 |
|---|---|---|
| `offline` | 502 / 503 / 504，或 fetch 直接抛错 | 顶部排障卡：结论 + 可在终端执行的命令（带复制）+「重新检测」；指标值显示 `—` 而不是 `0` |
| `unauthorized` | 401 | 一行红条：登录已失效 |
| `forbidden` | 403 | 一行红条：没有配置权限 |
| `server` / `unknown` | 其余 | 一行红条，附原始信息供排查 |

两条约束：

- **不显示 0**：服务不可达时拿不到指标，`0 次` 会被读成「今天没人用」，所以统一渲染 `—`；
- **不渲染空编辑器**：配置没读到时提示词 / 工具页签显示「配置未加载」，避免用户
  在一个空白框里改了半天、保存才发现什么都没提交。指标值与文案都按 `offline` 分支切换。

代理层同时给了机器可读字段，便于以后接监控：
`502 {"error": "...", "code": "AGENT_UNAVAILABLE", "hint": "cd agent && .venv\\Scripts\\python.exe app.py"}`。

## 八、已知限制

- 指标是按进程内 SQLite 累加，多实例部署会各记一份，需要换共享库或上报监控；
- 概览不显示「当前待审批数」，要看 pending 得进具体会话；
- 审批超时不会自动拒绝（中断一直挂在 checkpointer 里，直到有人处理）；
- 提示词只做长度校验，不做内容体检——改坏了只能靠「还原默认文案」。
