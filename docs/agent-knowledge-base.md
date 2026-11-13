# 本地知识库

Agent 的静态资料检索能力。数据存在本地 SQLite，向量由硅基流动的
`Qwen/Qwen3-Embedding-0.6B` 生成，检索用 `sqlite-vec` 的 vec0 扩展。

## 它解决什么问题

Agent 原本只有 `crm_*` 工具，查的是**实时业务数据**（线索、订单）。
被问「CBAM 怎么收费」「这个服务适合谁」时，模型只能凭预训练印象编，
而产品目录、价格区间、交付周期这些口径恰恰是最不能编的。

知识库把这类**静态资料**放进可检索的本地库，让模型先查再答。

| 查什么 | 用哪个工具 |
|---|---|
| 客户 / 线索 / 订单 / 业绩 | `crm_*`（走 CRM HTTP API，权限在服务端） |
| 产品服务 FAQ / 技能说明 / 项目文档 | `kb_search`（读本地 kb.sqlite3） |

两者可以组合：先 `kb_search` 确认产品口径，再 `crm_*` 取客户实况。

## 当前语料

当前库是《产品FAQ-1.0》单一语料：**22 篇 / 94 块**（一条 FAQ 一块）。

| 类型 | 来源 | 篇数 | 块数 | 说明 |
|---|---|---|---|---|
| `faq` | `../产品FAQ-1.0.csv` → 产品 FAQ 行 | 21 | 84 | 每产品一篇，内含服务内容 / 适用客户 / 交付与周期 / 计价方式四问 |
| `faq` | 同上 → 通用 FAQ 行 | 1 | 10 | 合作流程、售前诊断、差旅与第三方费用、多服务优惠、客户配合、交付物格式、加急、数据保密、案例引用、售后 |

`python -m kb.cli ingest`（不带 `--only`）还会额外导入技能、项目文档与产品总览：

| 类型 | 来源 | 篇数 | 说明 |
|---|---|---|---|
| `faq` | `产品FAQ-1.0.csv`（优先）→ `产品服务FAQ.xlsx` | 22 | 上表，CSV 优先；两者 `doc_key` 相同，是替换不是并存 |
| `product` | `产品服务FAQ.xlsx` → 产品服务总览表 | 21 | 每产品一段字段清单（价格区间、成交数、适合客户） |
| `skill` | `agent/skills/*/SKILL.md` | 2 | 技能说明本身也可被检索 |
| `doc` | `agent/docs/*.md`、两个 README | 1 | 项目文档 |

**当前部署只装了 FAQ 那 22 篇**（`ingest --only faq`）。要补回技能与文档语料：

```bash
python -m kb.cli ingest            # 全量（CSV 优先）
python -m kb.cli stats             # 看各类型篇数
```

除上表外，运维在「知识库管理」页面上传的文件记为 `file` 类型，与内置语料并存。
检索时 `doc_type` 留空即可覆盖全部类型。

**未纳入**：CRM 线索与沟通记录。那部分按客户维度隔离、涉及数据范围权限，
需要先定「谁能检索谁的线索」，否则等于绕过一遍脱敏规则。

## 命令

在 `agent/` 目录下执行：

```bash
# 建表（首次）
python -m kb.cli init

# 导入默认语料
python -m kb.cli ingest

# 只导某一类 / 指定 CSV / 强制重算 / 调整切块大小
python -m kb.cli ingest --only faq
python -m kb.cli ingest --only faq --csv "../产品FAQ-1.0.csv"
python -m kb.cli ingest --force --max-chars 500

# 检索自测
python -m kb.cli search "CBAM 填报怎么收费" -k 3
python -m kb.cli search "碳足迹" -t faq --min-score 0.6

# 库状态
python -m kb.cli stats
python -m kb.cli docs

# 清空重建
python -m kb.cli reset --yes
```

`ingest` 是幂等的：`doc_key` 相同且内容指纹未变会跳过，改一个字只重算那一篇。

## 表结构

```
kb_docs      普通表    文档元信息，doc_key 唯一
kb_chunks    普通表    切块正文（heading / content / char_len）
vec_chunks   vec0      向量 + 两个 metadata 列（doc_id / doc_type）
```

为什么正文放普通表而不是 vec0 的 `+content` 列：vec0 的 auxiliary 列
（`+` 前缀）**只能回传，不能过滤也不能 JOIN**。正文放里面就等于把自己锁死，
后续想加全文索引或按文档聚合都做不了。

为什么 `doc_type` 必须是 metadata 列：只有 metadata 列能在 KNN 查询里做
`WHERE doc_type = 'faq'`。写成 `+doc_type` 会直接报错：

```
An illegal WHERE constraint was provided on a vec0 auxiliary column in a KNN query
```

检索走 `vec0 MATCH → JOIN kb_chunks → JOIN kb_docs`，用别名限定
`v.embedding MATCH ? AND v.k = ?`（`k` 是 vec0 的参数，不是普通 WHERE 条件）。

## 切块策略

`kb/chunker.py`，按 Markdown 结构切，不按固定字数硬切：

- 先按 `#/##/###` 分节，维护标题栈生成完整路径（`产品 > 类别 > 问题`）
- 每节正文按段落聚合，超过 `max_chars`（默认 700）就分块
- 单段超限时按中文句末标点（。！？；）切，仍超长才硬切
- 表格与代码围栏作为不可分整体，表格内空行不触发分段
- 代码围栏里的 `#` 当作注释，不当标题

每块的 embedding 文本是 `标题 > 标题路径\n正文`，等于给短块补上下文；
落库的 `content` 仍是原文，展示不受影响。

按产品分文档而不是整表一篇：改一个产品的 FAQ 只重算这一篇，
而不是 90 多个块全重算。

## 检索

`kb/store.py::KBStore.search()`，三步：

1. **向量召回**：vec0 取 top `max(top_k*4, 20)`，可选 `doc_type` 过滤
2. **关键词加分**：`final = cosine + keyword_weight × 字符 bigram 覆盖率`
3. **同文档限流**：`max_per_doc`（默认 2），避免一篇长文档的碎片占满名额。
   设 3 时实测「绿证和碳交易有什么区别」top3 全是绿证，碳交易一条都进不来；
   设 2 后两个产品各占 2 条，对比类问题才答得全

第 2 步是**加法**不是加权平均。加权平均会把 0.88 的正确命中压到 0.70，
让 `min_score` 阈值失去可比性；加法下分数主体仍是 cosine，
加分项最多 `keyword_weight`（默认 0.15），因此**分数可能略超 1.0**。

关键词加分的必要性和局限：它能让标题里真的出现「步骤」「收费」这类字的块
往前排，但对「同义改写」（问「几步」、标题写「执行步骤」）无效 ——
那本来就该由向量负责。实测这类查询正确结果仍在前 3，够 RAG 用。

## 配置

`agent/.env`：

```ini
SILICONFLOW_API_KEY=sk-...
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
EMBEDDING_DIM=1024
EMBEDDING_BATCH_SIZE=32
KB_DB_PATH=
```

关于这个模型的实测结论（2026-11-13）：

| 项 | 结果 |
|---|---|
| 维度 | 1024（原生，未做 MRL 截断） |
| 归一化 | **已归一化**，模长 = 1.0，因此用 cosine，检索时不必再手工归一化 |
| 批量 | 单次 40 条可通，代码按 32 分批留 token 余量 |
| 返回顺序 | `data[].index` 可能与入参顺序不同，必须按 index 回填 |

`EMBEDDING_DIM` 必须与模型输出一致。vec0 的 `float[N]` 是建表时写死的，
维度改了要 `reset --yes` 重建，否则插入时报 dimension mismatch。

## 知识库管理页面（上传 / 查看切片 / 删除）

入口：左侧导航「智能助手 → 知识库管理」（`/agent-kb`），仅系统管理员可见
（判定同控制面板：账号管理 → 修改）。

| 能力 | 说明 |
|---|---|
| 列表 | 已挂载的每一篇文档：标题、来源、类型、切片数、字数、更新时间 |
| 切片详情 | 点列表里的「切片数」，右侧滑出抽屉，按 `ord` 展示每片原文、标题路径、字数，可片内搜索与逐片复制 |
| 删除 | 连同切块与向量一起删；不提供修改，改内容请重新上传同名文件（`doc_key` 相同会原地替换） |
| 上传 | 右上角「上传」，支持 `.md` / `.txt` / `.csv` / `.xlsx`，单文件 ≤ 20 MB |
| 处理状态 | 上传后面板显示排队 → 解析 → 切块 → 向量化（带百分比）→ 写入索引 → 已入库 |

切片抽屉展示的是 `kb_chunks.content`，即送进 embedding 的原始切块文本——
向量无法反解成人话，要验证「切得好不好、有没有把问答劈开」只能看这段原文。
单块上限 700 字（chunker 默认），整篇一次返回；`limit` 仅兜底（默认 500、上限 2000），
超出时接口返回 `truncated=true`，前端在列表底部标注「仅显示前 N 片」。
抽屉状态按 `doc_id` 做 key 重挂而不是在 effect 里复位，避免 effect 内同步 setState
触发级联渲染（`react-hooks/set-state-in-effect`）。

上传文件统一 `doc_type=file`，与内置语料共用同一条入库链路
（`RawDoc` → `split_markdown` → embedding → `upsert_document`），
因此幂等、检索、权限规则完全一致。

**为什么表格要按「列名：值」逐行渲染**：整张 Markdown 表送进 embedding 时，
模型看到 `| 30,000~40,000 | 咨询评价 |` 不知道列含义；把列名并进每行，
「参考价格：30,000~40,000」才可能被「多少钱」命中。单表最多 2000 行，
超出会在正文首行注明已截断。

**为什么上传走 base64 JSON 而不是 multipart**：`/agent-api/*` 代理统一按 JSON 透传
（`content-type: application/json`），multipart 过不去。知识库文件都是几十 KB，
base64 膨胀 33% 可以接受。

接口（均需管理员）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/kb/documents` | 文档清单 + 库统计 + 最近任务 |
| GET | `/kb/documents/{doc_id}/chunks` | 单篇文档的切片明细（`doc` + `chunks[]`：`ord` / `heading` / `chars` / `content`） |
| POST | `/kb/upload` | `{filename, content_base64}` → 立即返回 `job_id`，后台线程处理 |
| GET | `/kb/jobs` | 任务进度，前端 1 秒轮询 |
| DELETE | `/kb/documents/{doc_id}` | 删除文档（含切块与向量），并摘掉引用它的任务卡 |

任务状态放内存（`kb/jobs.py`）而不是 SQLite：进度是一次性状态，
进程重启后正在跑的任务本就中断了，落盘只会留下永远 `processing` 的假记录。
**文档是否真入库以 `kb_docs` 为准。** 上传任务串行执行，避免并发争 SQLite 写锁。

## vec0 扩展

`kb/store.py::locate_extension()` 先找 `sqlite_vec` 包自带的 `vec0.dll`，
找不到再回退 `../sqlite-vec/dist/vec0.dll`（离线部署用）。

本机无 make/gcc，不能从源码编译；GitHub Release 的 tar.gz 走
`objects.githubusercontent.com` 被拦，镜像也不通，因此用 PyPI wheel 内的
官方产物 —— 与 release 包同一份二进制，已用裸 `load_extension()` 验证。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `知识库不存在` | 没建库 | `python -m kb.cli init` |
| `缺少 SILICONFLOW_API_KEY` | `.env` 没配 | 补 key |
| `维度不符：配置 1024，实际 X` | 模型与 `EMBEDDING_DIM` 不匹配 | 改配置或换模型 |
| `找不到 vec0 扩展` | 没装 sqlite-vec | `pip install sqlite-vec` |
| 检索结果不相关 | 语料没入库 / 表述差异大 | `stats` 看文档数，换说法再试 |
| `illegal WHERE constraint` | 过滤字段建成了 `+col` | 改成 metadata 列并重建 |
| 检索慢 | 首次调用要建连接 + 加载扩展 | 连接按线程缓存，第二次起正常 |
| `reset` 后仍检索到旧数据 | Agent 进程持着旧连接 | **重启 Agent 服务**。`KBStore` 按线程缓存连接，重建库不会自动重连 |

## 代码地图

```
agent/kb/
├── config.py      环境变量 → KBConfig，维度校验
├── embedding.py   硅基流动客户端（分批 / 重试 / 查询缓存）
├── chunker.py     Markdown 切块
├── store.py       kb.sqlite3 建表 / 写入 / 混合检索 / 按 doc_id 删除
├── loader.py      语料 → RawDoc（skills / md / xlsx / csv）
├── upload.py      上传文件 → RawDoc（文本 / CSV / Excel）
├── jobs.py        上传任务状态机 + 后台线程（进度、串行执行）
└── cli.py         init / ingest / search / stats / docs / reset
agent/tools_kb.py  Agent 工具 kb_search
```
