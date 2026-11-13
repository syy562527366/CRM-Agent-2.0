# Agent Skill 能力（渐进式披露）

2026-11-06 起，Agent 服务接入 deepagents 的 `SkillsMiddleware`，支持用「技能包」把一套
业务做法固化下来，模型按需自己取用，不用改代码、不用重启。

## 为什么用 Skill 而不是继续加提示词

系统提示词是每轮都全量发送的。把「周报怎么写」「线索怎么诊断」这类长流程直接堆进提示词，
会有三个问题：每次请求都付这份 token、几条流程互相干扰、改一条要动整个提示词。

Skill 是**渐进式披露**：

| 阶段 | 进上下文的内容 | 量级 |
|---|---|---|
| 每轮开始 | 只有每个技能的 `name` + `description` | 每个几十字 |
| 模型判断需要时 | 自己调 `read_file` 读该技能 `SKILL.md` 全文 | 只这一份 |
| 用到附件时 | 再 `ls` / `read_file` 取模板、示例 | 按需 |

也就是说：**技能有多少个，平时只花多少行提示词**；具体步骤只在真正用到的那一轮才产生费用。

## 目录结构

```
agent/skills/                      技能根目录（跟着 git 走，所有账号共用）
├── weekly-report/
│   └── SKILL.md                   销售周报生成
├── lead-analysis/
│   └── SKILL.md                   线索跟进诊断（五张数据卡片）
└── product-faq/
    └── SKILL.md                   产品FAQ问题解答（查 kb 回答产品服务问题）

agent/skills-disabled/             已关闭的技能（不在 /skills/ 路由里，模型完全看不到）
└── <name>/
    └── SKILL.md
```

技能目录挂在 `CompositeBackend` 的 `/skills/` 路由上：

| 模型看到的路径 | 实际落盘位置 | 可见范围 |
|---|---|---|
| `/skills/...` | `agent/skills/...` | 所有账号共用同一份 |
| 其余所有路径 | `agent/workspace/<账号ID>/` | 按账号隔离 |

两者的 `FilesystemBackend` 都是 `virtual_mode=True`，所以 `/../.env` 这类穿越会被直接拒绝
（已实测抛 `Path traversal not allowed`），`agent/.env`、项目 `data/*.json` 读不到。

## SKILL.md 格式

```markdown
---
name: weekly-report
description: 按固定结构生成销售周报。当用户说「出周报」「本周业绩」时使用。
---

# 标题

## 何时使用
...

## 执行步骤
...
```

frontmatter 规则（来自 Agent Skills 规范，`skills_store.py` 里做了校验）：

| 字段 | 必需 | 约束 |
|---|---|---|
| `name` | 是 | 1-64 字符，只能小写字母 / 数字 / 连字符；不能以连字符开头结尾、不能有连续 `--`；**必须与目录名完全一致** |
| `description` | 是 | ≤1024 字符。模型就是靠这句话判断「这次该不该用这个技能」，要写清**做什么** + **什么话术触发** |
| `license` | 否 | 仅展示 |
| `allowed-tools` | 否 | 空格分隔的允许工具，会显示在技能列表旁 |
| `metadata.include_tools` | 否 | 高级用法：读到本技能后才对模型暴露指定工具 |

`description` 是最关键的一行。写成「用于生成周报」模型很难判断何时触发；
写成「按固定结构生成销售周报，用户说『出周报』『本周业绩』时使用」，命中率就高得多。

## 新增一个技能

1. 建目录 `agent/skills/<技能名>/`（名字用 kebab-case）
2. 在里面写 `SKILL.md`，frontmatter 的 `name` 与目录名保持一致
3. 需要模板 / 示例文件就一起放进这个目录，正文里写清「用 `read_file` 读 `xxx.md`」
4. 保存即可 —— **不用重启服务**。下一句话就会带上新技能（见下面「生效时机」）
5. 打开 `/skills` 接口或让管理员访问 `GET /skills` 确认 `valid=true`

> 目录名前缀为 `_` 或 `.` 的会被跳过，可以放草稿。

## 生效时机

每轮对话的入参都带 `skills_metadata=None`（`app._turn_input()`），这是框架约定的
「请重读技能目录」信号。因此：

- 新增 / 修改 / 删除技能文件 → **下一句话就生效**，不需要新建会话
- 改技能的**文件名或目录名**后旧记录不会残留（每轮重扫）

`POST /skills/reload` 只用于改了 `AGENT_SKILLS_DIR` 这类路径配置、或怀疑缓存没刷新时，
它会清空 `_build_agent` 的 LRU 缓存。

## 启用 / 关闭：为什么是「移动目录」

框架的 `SkillsMiddleware` 只做一件事：`ls` 一遍来源目录的**顶层子目录**，
谁有 `SKILL.md` 就把谁的 `name` + `description` 注入提示词。
它**没有** `enabled` 之类的过滤参数（0.7.32 源码 `_list_skills_with_errors()`），
所以「在 frontmatter 加个开关字段」这种方案不成立 —— 目录留在原地，
模型照样能看到、照样能 `read_file` 读到。

因此开关做在**目录层**：

| 状态 | 位置 | 模型可见性 |
|---|---|---|
| 启用 | `agent/skills/<name>/` | 出现在技能列表；可 `read_file /skills/<name>/SKILL.md` |
| 关闭 | `agent/skills-disabled/<name>/` | 完全不可见：列表里没有、按路径读也 404 |

这么做的好处是「关闭」是硬的：不是提示词里劝模型别用，而是它连技能名都不知道。
代价是 git 里会看到一次 rename（`skills/x` → `skills-disabled/x`），
这恰好也是状态本身，比另存一份 JSON 开关更不容易与文件实际状态不一致。

接口侧 `POST /skills/{name}/toggle` 完成移动后立即 `_build_agent.cache_clear()`；
技能内容本身每轮都会重扫（`skills_metadata=None`），所以**不重启服务**，
下一句话就按新状态执行。

## 在线编辑

`Skill 管理` 页签的「编辑」直接改 `SKILL.md` 原文，保存走 `PUT /skills/{name}`。
写盘前按启动时同一套规则校验（`skills_store._validate`）：

| 规则 | 不满足时 |
|---|---|
| 必须有 YAML frontmatter | 400，不落盘 |
| `name` 等于目录名、且符合 `^[a-z0-9]+(-[a-z0-9]+)*$` | 400，不落盘 |
| `description` 非空且 ≤ 1024 字 | 400，不落盘 |
| 正文不能为空 | 400，不落盘 |

**校验不过就不写盘**，而不是「先存下来再标红」：控制面板里改错一个缩进，
技能会立刻变 `invalid`，模型下一轮直接丢掉它，而现场已经被覆盖了 —— 那是最难救的情况。
写盘用「临时文件 + `os.replace`」，避免写到一半进程被杀留下半篇 SKILL.md。
关闭状态的技能同样可以编辑（`resolve_dir()` 两个目录都找）。

## 现有技能

| 技能 | 触发场景 | 依赖 | 产出 |
|---|---|---|---|
| `weekly-report` | 出周报 / 本周业绩 / 汇报销售情况 | `crm_*_stats` + `calculator` | 四段式 Markdown |
| `lead-analysis` | 分析某个客户 / 为什么没成交 / 下一步怎么跟 | `crm_get_lead` + `crm_get_lead_timeline` | 五张数据卡片（`lead-report` 围栏） |
| `product-faq` | 这个服务怎么收费 / 适合谁 / 交付什么 / 多久 / 有没有 XX 服务 | `kb_search(doc_type="faq")` | 结构化问答 + 来源 |

### product-faq（产品FAQ问题解答）的两个关键约定

1. **按维度分次检索，不要一次 `top_k` 通吃**。每个产品在知识库里固定 4 块：
   服务内容 / 适用客户 / 交付与周期 / 计价方式。用户一句话问三个方面时，
   实测一次 `top_k=5` 只能覆盖两三块，剩下的会被答成「知识库里没有」。
2. **`doc_type="faq"` 必须显式传**。库里除了产品 FAQ 还有技能说明与项目文档，
   不过滤会把「技能该怎么写」捞进产品回答里。这条约束同时写在
   `tools_kb.py` 的工具描述里——只写技能正文时模型会漏传（实测第一轮就没传）。

产品名对不上时（「零碳工程」「碳盘查」）走三步纠偏：原话检索 → 类别词检索 →
列出最接近的 2–3 个真实产品让用户确认，**禁止**拿相近产品顶替作答。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/skills` | 技能清单 + 校验结果 + 启用状态（仅管理员，判据同控制面板：`accounts.修改`） |
| GET | `/skills/{name}` | 单篇 `SKILL.md` 原文（含 `content`），供编辑弹窗 |
| PUT | `/skills/{name}` | 覆写 `SKILL.md`，写盘前校验；成功后清 Agent 缓存 |
| POST | `/skills/{name}/toggle` | `{enabled: true/false}`，在 `skills/` 与 `skills-disabled/` 之间移动目录 |
| POST | `/skills/reload` | 清空 Agent 实例缓存并重扫目录（仅管理员） |
| GET | `/health` | `skills`（可用技能名）/ `skills_total`（扫描总数）/ `skills_disabled`（关闭数） |

`GET /skills` 返回体：

```json
{
  "root": "…/agent/skills",
  "disabled_root": "…/agent/skills-disabled",
  "route": "/skills/",
  "total": 3,
  "valid": 3,
  "enabled": 2,
  "disabled": 1,
  "invalid": 0,
  "names": ["lead-analysis", "product-faq"],
  "skills": [
    {
      "name": "weekly-report",
      "description": "按固定结构生成销售周报…",
      "path": "/skills/weekly-report/SKILL.md",
      "files": [],
      "allowed_tools": [],
      "include_tools": [],
      "license": "",
      "enabled": false,
      "valid": true,
      "errors": []
    }
  ]
}
```

写坏的技能 `valid=false`，`errors` 里是中文原因；**它不会被传给模型**，
所以一处笔误不会污染所有对话，只会在这张表里亮红灯。

## 和现有机制的关系

| 机制 | 粒度 | 作用 | 存放 |
|---|---|---|---|
| Skill | 一套做法（多步流程） | 告诉模型「这类任务按什么步骤做」 | `agent/skills/<name>/SKILL.md` |
| Tool | 一个能力（一次调用） | 让模型能取数 / 改数 | `tools*.py` + `REGISTRY` |
| 提示词 | 全局纪律 | 数据纪律、写操作纪律、回答风格 | `data/agent_config.json` |

三者是叠加关系：技能里写「先调 `crm_sales_stats`」，靠的还是工具；
而技能不能绕过工具权限 —— 技能里写「直接改线索」照样会弹审批卡，
写「删除线索」照样没有这个工具。

## 排查清单

| 现象 | 先看这里 |
|---|---|
| 模型说不知道有这个技能 | `GET /skills` 里该技能是不是 `enabled=false`；再看 `errors` |
| 技能列出来了但不触发 | 十有八九是 `description` 没写触发话术 |
| 模型读了 SKILL.md 但没照做 | 正文步骤是否可执行（有没有写清工具名、参数、输出结构） |
| 改了文件没生效 | 确认文件保存到了 `agent/skills/` 而不是工作目录；必要时 `POST /skills/reload` |
| 保存报「name 必须与目录名一致」 | frontmatter 的 `name` 被改过；目录名不允许在编辑器里改 |
| 读取报 `Path traversal not allowed` | 技能里写了 `../` 路径，改成 `/skills/...` 绝对虚拟路径 |

## 已验证

- `ls /skills` → `read_file /skills/weekly-report/SKILL.md` → 按四段结构输出周报，
  并自主调用 `crm_sales_stats` / `crm_lead_stats` / `calculator` 算环比（2026-11-06 实测）
- 越权路径 `/../.env` 被 `FilesystemBackend` 拒绝
- **开关 A/B（2026-11-13 实测）**：同一句「帮我出一份销售周报」——
  启用时第一个工具就是 `read_file /skills/weekly-report/SKILL.md`；
  关闭后整轮 13 次工具调用里**没有任何 `read_file`**，模型只靠自己凑出周报，
  说明技能确实没进上下文。重新启用后立即恢复读取。
- **编辑校验（2026-11-13 实测）**：正常保存 200 且 `valid=true`；
  把 `name` 改成 `another-skill` 保存 → 400「name 必须与目录名一致」，且原文件未被改动
- `product-faq`：问「绿色工厂评价怎么收费、适合谁、多久」→ 读技能后按三维度检索，
  按模板输出并注明来源；问「零碳工程怎么报价」→ 不编造，指出无此产品并给出最接近的
  「零碳工厂咨询」，反问确认口径；问「绿证和碳交易有什么区别」→ 两个产品各命中 2 块，
  给出张 / 吨两种口径并明确「不能横向比价」（2026-11-13 实测）
