# Agent 工具限制与人工审批 —— 设计方案

> 目标：限制 Agent 能用哪些工具、能操作到什么程度，并在高危操作前停下来等人批准。
> 环境：deepagents 0.7.32 / langchain 1.4.7 / langgraph 1.2.18 / FastAPI + SqliteSaver。
> 本文所有 API 签名与行为都在本机实测过，不是文档推断。

---

## 一、结论先说

**三层防线，各管一件事，缺一不可：**

| 层 | 作用 | 实现位置 | 回答的问题 |
|---|---|---|---|
| **L1 工具裁剪** | 角色看不到无权限的工具 | `app.py` 构建 agent 时按 `ctx.permissions` 过滤 `TOOLS` | 这个账号能用哪些工具？ |
| **L2 静态约束** | 参数与数据范围硬校验 | 工具内部（已实现） | 就算调了，能改到什么范围？ |
| **L3 人工审批** | 高危操作前暂停，等人点确认 | `interrupt_on` + HITL 中间件 | 这一步要不要人拍板？ |

**关键认知：审批不能替代权限。** 即使用户点了「批准」，工具内部的权限位与数据范围仍要再校验一次。审批是「多一道人」，不是「放行开关」。反过来，权限也不能替代审批——权限只判断「能不能」，不判断「这次该不该」。

推荐用 deepagents 自带的 `interrupt_on`（底层是 langchain 的 `HumanInTheLoopMiddleware`），不要自己在工具里手写审批。

---

## 二、现状盘点：已经有什么

| 已有能力 | 位置 | 覆盖的风险 |
|---|---|---|
| 身份注入（`x-crm-context`，模型不可见） | 代理层 + `_config()` | 冒用他人身份 |
| 权限位双检（本地 `ctx.can()` + CRM API Bearer 校验） | `tools_crm*.py` | 越权调用 |
| 数据范围（仅自己）在服务层强制 | `src/lib/crm/scope.ts` | 看到别人的数据 |
| 写字段白名单 `_LEAD_PATCH` / `_ORDER_PATCH` | `tools_crm_write.py` | 改 id / createdAt 这类字段 |
| 参数校验（状态枚举、11 位手机号、姓名长度、金额 > 0） | `tools_crm_write.py` | 脏数据 |
| 重名歧义返回候选、不擅自选一条 | `_resolve_lead()` | 改错人 |
| 删除留底 `trash.jsonl` + 全量审计 `audit.jsonl` | `tools_crm_write.py` | 事后追溯 |
| 提示词纪律（含糊指令先问、一次一条、拒绝不绕过） | `SYSTEM_PROMPT` | 模型自作主张 |

**缺的只有一件事：高危动作前没有人拦。** 现在模型决定删除，就直接落盘了，靠的是权限位和提示词。提示词是软约束，模型完全可以不遵守。

另外有一个隐蔽的问题：**当前 `app.py` 的流式循环会把中断事件直接丢掉。**

```python
for node, delta in (chunk or {}).items():
    if not isinstance(delta, dict):
        continue   # ← __interrupt__ 的值是 tuple，在这里被静默跳过
```

也就是说：如果现在直接加上 `interrupt_on`，用户会看到 Agent 卡住、没有回复、也没有报错。这一行必须改，否则整个方案跑不起来。

---

## 三、实测能力清单

### 3.1 `create_deep_agent(interrupt_on=...)`

```python
create_deep_agent(
    model=..., tools=..., checkpointer=...,
    interrupt_on={
        "crm_delete_lead": {
            "allowed_decisions": ["approve", "reject"],
            "description": "即将删除线索，请确认",
            "when": lambda req: True,        # 可选：条件审批
            "args_schema": {...},            # 可选：edit 决策允许改哪些参数
        },
        "crm_update_order": True,            # 简写 = 该工具每次都要审
    },
    interrupt_mode="batched",                # 默认；另一选项 "per_call"
)
```

`InterruptOnConfig` 的四个字段（实测自 `inspect.getsource`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `allowed_decisions` | `list["approve"\|"edit"\|"reject"\|"respond"]` | 允许哪些决策 |
| `description` | `str` 或 `callable(tool_call, state, runtime) -> str` | 审批卡片上给人看的说明，可动态生成中文文案 |
| `args_schema` | `dict` | 允许「编辑参数」时的表单约束 |
| `when` | `callable(ToolCallRequest) -> bool` | **条件审批**：只有满足条件才拦 |

`when` 拿到的 `ToolCallRequest` 有 `tool_call`（含 `name` / `args` / `id`）、`tool`、`state`、`runtime` 四个字段。这意味着可以做「只有金额变动超过 30% 才审」这类精细化规则。

### 3.2 四种决策（`Decision` 联合类型）

```python
{"type": "approve"}                                        # 批准，原样执行
{"type": "edit", "edited_action": {"name": ..., "args": {...}}}   # 改参数后执行
{"type": "reject", "message": "这条不能删"}                 # 拒绝，工具不执行
{"type": "respond", "message": "..."}                      # 不执行，直接用这句话当工具结果
```

- `reject` 与 `respond` 的区别：`reject` 会以「被拒绝」的形式告知模型；`respond` 直接伪造一个工具返回内容，模型会当成正常结果继续（慎用，等于让人冒充工具）。
- **实测**：`approve` 后工具真的执行（`executed=['LD-1']`）；`reject` 后工具不执行（`executed=[]`）。

### 3.3 中断长什么样

`agent.stream(..., stream_mode=["messages","updates"])` 的 `updates` 流里会多出一个 key：

```
INTERRUPT id = 98fcbd1f...
  value keys = ['action_requests', 'review_configs']
  action_requests = [{'name': 'crm_delete_lead', 'args': {'lead_id': 'LD-1'},
                      'description': 'Tool execution requires approval\n\nTool: crm_delete_lead\nArgs: ...'}]
  review_configs = [{'action_name': 'crm_delete_lead', 'allowed_decisions': ['approve', 'reject']}]
```

注意 `description` 默认是英文的，必须用 `description` 工厂函数换成中文，否则前端卡片会出现英文。

### 3.4 恢复执行

```python
from langgraph.types import Command

agent.stream(
    Command(resume={"decisions": [{"type": "approve"}]}),
    config=同一条 thread 的 config,
    stream_mode=["messages", "updates"],
)
```

**前提：必须有 checkpointer**（我们已有 `SqliteSaver`），中断状态就存在 `agent.db` 里，进程重启也能接着批。

### 3.5 `batched` vs `per_call`

| 模式 | 中断粒度 | 决策顺序 | 适合场景 |
|---|---|---|---|
| `batched`（默认） | 一个模型轮次一次中断 | **按位置匹配** `action_requests` 的下标 | 一次批准多个连续操作，体验顺 |
| `per_call` | 每个被拦截的工具调用一次 | 按 interrupt id 单独回 | 逐个确认，实现更直观（未来默认） |

**风险点**：`batched` 下决策靠数组下标对应，前端如果按工具名匹配，模型一次调两个同名工具就会错位。前端必须按下标回传。

建议 v1 用 `batched`（框架默认、稳定），前端按 `action_requests` 顺序渲染成一张卡片里的多行。

### 3.6 文件系统权限（L2 的补充）

deepagents 的 `permissions` 参数支持 `FilesystemPermission(operations, paths, mode)`，`mode` 可选 `allow` / `deny` / `interrupt`：

```python
permissions=[
    FilesystemPermission(operations=["write"], paths=["/secrets/**"], mode="deny"),
    FilesystemPermission(operations=["read"], paths=["/**"], mode="allow"),
]
```

我们现在用 `FilesystemBackend(virtual_mode=True)` 已经把根锁在 `agent/workspace/<账号>/`，路径穿越会抛 `ValueError`。所以文件这块暂时不需要再加规则；如果以后放开共享目录，再用 `permissions` 精确控制。

---

## 四、限制模型：三层怎么配合

### L1 工具裁剪（按角色给不同工具集）

现状：13 个工具对所有角色一视同仁，销售也能看到 `crm_delete_lead`，调用后才被 `PERMISSION_DENIED` 拦下。体验上是「点了才知道不行」，更合理的做法是**一开始就不给**。

```python
def _tools_for(ctx: CrmCtx) -> list:
    tools = [*BASE_TOOLS, *CRM_TOOLS]
    if ctx.can("leads", "修改"):
        tools.append(crm_update_lead)
    if ctx.can("leads", "删除"):
        tools.append(crm_delete_lead)
    ...
```

**注意实现细节**：`get_agent()` 现在用 `@lru_cache(maxsize=16)` 且**只按 workspace 缓存**。加入按角色的工具裁剪后，缓存键必须变成 `(workspace, role_id)`，否则张明（销售）和李华（管理员）会共用同一个 agent 实例，工具集串味——这是权限漏洞，不是小 bug。

**取舍**：裁剪后模型看不到工具，就不会傻乎乎地去调用再解释「我没有权限」，回答更干脆。但如果用户问「你能帮我删线索吗」，模型会说「我没这个能力」，而不是「你的账号没有删除权限」。建议在 system prompt 里固定一句：**「没有提供某类工具时，说明是当前账号权限不足，不要说系统不支持」**。

### L2 静态约束（已实现，保持）

- 写字段白名单：只允许改声明过的字段，防止模型改 `id` / `createdAt` / `communicationCount`
- 先读后写：改前 GET 原记录，既确认数据范围，也拿旧值做 diff
- 参数校验：枚举、格式、长度、正数
- 不猜目标：重名返回候选
- 删除留底：可回捞

这一层是**兜底**，不管审批结果如何都执行。审批通过的「编辑参数」也要重新走一遍这套校验——人改的参数也可能不合法。

### L3 人工审批（本轮要加的）

用 `interrupt_on` + `when` 条件，只拦真正高危的动作。**不要全量拦截**——每个读操作都弹窗，用户三天就关掉这个功能了。

---

## 五、推荐的审批矩阵

按「不可逆性 × 影响面」分三档：

| 工具 | 触发条件 | 允许的决策 | 理由 |
|---|---|---|---|
| `crm_delete_lead` / `crm_delete_order` | 总是 | approve / reject | 不可逆，即使有 trash 留底 |
| `crm_update_order` | `when`: 金额变动 ≥ 30% | approve / edit / reject | 涉及金额，误改直接影响收入 |
| `crm_update_lead` | `when`: 改 `name` / `phone` / `assignee` | approve / edit / reject | 主数据或归属变更，影响数据范围 |
| `crm_update_lead` | 只改 status / priority / remark | 不拦 | 高频、低风险、可改回 |
| 只读工具（7 个） | 永不 | — | 查询不该打断 |
| `write_file` / `edit_file` | 不拦 | — | 已被 `virtual_mode` 限制在个人 workspace 内 |
| 未登记的新工具 | 总是（fail-closed） | approve / reject | 新增工具忘了配策略时默认从严 |

条件审批的写法：

```python
_LEAD_SENSITIVE = {"name", "phone", "assignee"}

def _lead_needs_review(req) -> bool:
    args = req.tool_call.get("args") or {}
    return any(args.get(f) for f in _LEAD_SENSITIVE)

def _order_needs_review(req) -> bool:
    args = req.tool_call.get("args") or {}
    amount = args.get("amount")
    # 只有「改金额」且幅度不可忽略才拦；查原值需要额外请求，
    # 这里用保守规则：只要传了 amount 就拦，人工看一眼成本很低
    return amount is not None

INTERRUPT_ON = {
    "crm_delete_lead": {"allowed_decisions": ["approve", "reject"], "description": _desc_delete},
    "crm_delete_order": {"allowed_decisions": ["approve", "reject"], "description": _desc_delete},
    "crm_update_lead": {"allowed_decisions": ["approve", "edit", "reject"],
                        "description": _desc_update, "when": _lead_needs_review},
    "crm_update_order": {"allowed_decisions": ["approve", "edit", "reject"],
                         "description": _desc_update, "when": _order_needs_review},
}
```

> 金额 30% 的阈值如果要做准，需要工具在拦截前先取原值。更简单的做法是：**只要动了金额就拦**，人工确认一次的成本远低于改错的成本。等真有高频批量调价需求时再做阈值。

---

## 六、接口与事件协议

### 6.1 新增 SSE 事件 `approval_required`

```json
{
  "type": "approval_required",
  "thread_id": "s-xxx",
  "interrupt_id": "98fcbd1f...",
  "actions": [
    {
      "index": 0,
      "tool": "crm_delete_lead",
      "label": "删除线索",
      "summary": "删除 江小波（LD-2026-0033，价格异议）",
      "args": {"lead_id": "LD-2026-0033"},
      "allowed_decisions": ["approve", "reject"]
    }
  ],
  "mode": "batched"
}
```

`summary` 由后端的 `description` 工厂函数生成（能拿到 `state`，可以顺带把客户姓名、金额查出来），比前端拼参数好看得多。

### 6.2 新增接口 `POST /chat/resume`

```json
{
  "thread_id": "s-xxx",
  "decisions": [
    {"type": "approve"},
    {"type": "reject", "message": "这条不能删"}
  ]
}
```

返回同样是 SSE 流（继续 `messages` + `updates`），前端复用同一套渲染逻辑。`decisions` 顺序必须与 `actions` 一致。

### 6.3 前端交互

```
┌─────────────────────────────────────────────┐
│ ⚠ 需要确认 · 1 项待审批                      │
│                                             │
│ 删除线索  crm_delete_lead              [展开]│
│ 删除 江小波（LD-2026-0033，价格异议）        │
│                                             │
│ [拒绝]  [修改参数]  [批准]                    │
└─────────────────────────────────────────────┘
```

要点：

- **批准按钮不做二次确认**（用户已经点了批准，再确认是冗余）
- **拒绝**要能填理由（`reject.message` 会传给模型，模型据此给出解释）
- 审批卡出现时**禁用输入框**，避免用户在 pending 状态下继续发消息
- 多个 action 时按 `index` 顺序渲染，一次提交全部决策
- 「修改参数」用 `edit` 决策，提交 `edited_action: {name, args}`；后端仍需过 L2 校验

### 6.4 会话状态的坑

中断后该 thread 处于 pending 状态。如果用户这时候**切到别的会话再切回来**，或者**刷新页面**：

- `GET /threads/{id}` 现在只回历史消息，不会告诉前端「这个会话还在等人批准」
- 需要补：`GET /threads/{id}` 返回 `pending_approval: {interrupt_id, actions}`，前端据此重新渲染审批卡
- 更简单的 v1 做法：pending 时**不允许切换**？不现实。还是补接口字段。

另外：pending 状态下用户直接发新消息，LangGraph 会拒绝（该 thread 正等待 resume）。前端要提前拦住并提示「请先处理待审批操作」。

---

## 七、实现要点（按改动顺序）

### 1. `agent/tools_guard.py`（新增）

集中放审批策略，不要散在 `app.py` 里：

```python
INTERRUPT_ON = {...}          # 工具 → 配置
def build_interrupt_on() -> dict: ...
def describe(name, args, state) -> str: ...   # 中文摘要
```

### 2. `agent/app.py`

- `create_agent_with()` 传入 `interrupt_on=INTERRUPT_ON`
- `get_agent()` 缓存键改为 `(workspace, role_id)`（配合 L1 裁剪）
- `event_source()` 里显式处理 `__interrupt__`：

```python
for node, delta in (chunk or {}).items():
    if node == "__interrupt__":
        for it in delta:
            yield sse({"type": "approval_required", ...})
        continue
    if not isinstance(delta, dict):
        continue
```

- 中断后不要发 `[DONE]`，发一个 `{"type":"paused"}` 让前端知道「不是结束，是等人」
- 新增 `POST /chat/resume`，逻辑与 `chat_stream` 几乎一样，只是入参换成 `Command(resume=...)`
- 审计：resume 时把 `approved_by`（当前账号）、`decision`、`reason` 写进 `audit.jsonl`

### 3. `agent/test_guardrails.py`（新增）

不用模型，直接构造 `interrupt_on` 的配置与 `when` 函数做单测，再用假模型跑「中断 → 批准 / 拒绝 / 改参数」三条链路（本文第三节的探针可直接演变成测试）。

### 4. 前端 `AgentChat.tsx` + `ApprovalCard.tsx`

- 解析 `approval_required` 事件，压入消息的 `pendingApproval` 字段
- 新增 `ApprovalCard` 组件
- `approve / reject / edit` 三个动作分别 POST `/chat/resume` 并接管后续流

---

## 八、验收用例

| # | 场景 | 期望 |
|---|---|---|
| 1 | 管理员让 Agent 删一条线索 | 出现审批卡，未批准前线索仍在；批准后删除 |
| 2 | 同上，点拒绝并填理由 | 工具不执行，模型回答「已取消，原因：…」且不重试 |
| 3 | 让 Agent 改线索状态（只改 status） | **不弹审批**，直接执行 |
| 4 | 让 Agent 改客户姓名 | 弹审批；点「修改参数」改成另一个名字后批准，落盘是新名字 |
| 5 | 销售账号 | 工具列表里没有 `crm_delete_*`；问「能删线索吗」回答「当前账号权限不足」而不是「系统不支持」 |
| 6 | 审批卡出现时切走会话再切回 | 审批卡仍在（`/threads/{id}` 带回 pending 信息） |
| 7 | 批准后工具内部仍校验数据范围 | 批准「改别人的线索」→ 仍返回 404 / PERMISSION_DENIED |
| 8 | 进程重启后回来批 | pending 状态还在（SqliteSaver 已落库） |
| 9 | 审批记录 | `audit.jsonl` 里有 `approved_by / decision / tool / args` |

---

## 九、风险与取舍

| 风险 | 说明 | 对策 |
|---|---|---|
| 审批疲劳 | 拦得太勤，用户会习惯性点批准，等于没有 | 只拦不可逆 + 主数据变更；状态类操作放行 |
| 决策错位 | `batched` 按数组下标匹配，前端按名字匹配会串 | 前端严格按下标回传，卡片顺序与 `action_requests` 一致 |
| pending 卡死 | 用户关掉页面，会话一直等人批 | 前端「取消本轮」按钮 → 发 `reject` 兜底；或加超时自动 reject |
| 审批被当成放行 | 有人以为批了就能绕过权限 | 工具内 L2 校验始终生效，审批只是加一道人 |
| 体验割裂 | 每次高危操作都要人盯着 | P2 可加「本会话内同类操作不再询问」（需记入审计，风险自负） |
| 隐藏工具的解释成本 | 裁剪后模型不知道「为什么没有这个能力」 | system prompt 固定话术 |

---

## 十、备选方案对比（为什么不用它们）

| 方案 | 做法 | 为什么不选 |
|---|---|---|
| **纯提示词** | 在 system prompt 里要求「删除前必须问用户」 | 软约束，模型可以不听；无法审计 |
| **工具内自实现审批** | 在工具函数里调 `interrupt()` | 每个工具都要写一遍，容易漏；参数校验与审批逻辑混在一起 |
| **代理层拦截** | Next 代理解析 SSE 里的 tool 事件，再弹窗 | 要把流拆开再拼回去，实现复杂且脆弱；Agent 直连 3200 时完全失效 |
| **只靠权限位**（现状） | 销售删不了，管理员随便删 | 管理员误操作没有任何拦截，正是本次要解决的 |
| **`interrupt_on`（推荐）** | 框架层中间件统一处理 | 官方支持、与 checkpointer 天然配合、支持条件审批与参数编辑 |

---

## 十一、建议的落地顺序

| 阶段 | 内容 | 产出 |
|---|---|---|
| **S1 后端** | `tools_guard.py` + `app.py` 处理 `__interrupt__` + `/chat/resume` + 审计补 `approved_by` | curl 可以走完「中断 → 批准/拒绝」全流程 |
| **S2 前端** | `ApprovalCard` + resume 调用 + pending 状态恢复 | 浏览器里能点批准/拒绝 |
| **S3 策略** | 条件审批 `when` + L1 角色裁剪（含缓存键修正） | 销售看不到删除工具；改状态不弹窗 |
| **S4 加固** | 测试用例 9 条 + 超时/取消兜底 + `GET /threads` 带 pending | 全绿 |

S1 不依赖前端，可以先用 curl 验证；S3 的缓存键改动涉及权限，必须单独验证「销售与管理员交替使用不会串工具」。
