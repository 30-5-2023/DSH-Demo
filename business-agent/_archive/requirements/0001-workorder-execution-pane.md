> **已归档：这是讨论存档，不要作为设计依据。当前设计只有一份 → [../../DESIGN.md](../../DESIGN.md)**

# 0001 右侧浏览页替换为工单作业页

## 基本信息

| 项 | 内容 |
|---|---|
| 编号 | 0001 |
| 标题 | 右侧浏览页替换为工单作业页 |
| 提出人 | 本仓库二次开发需求方 |
| 记录时间 | 2026-09-16 |
| 状态 | 澄清中 |
| 关联特性 | F-002（见 [../FEATURES.md](../FEATURES.md)） |

## 当前结论

把 DSH Web 界面右侧的「浏览页」（右栏展开后的默认页面）整体替换为**工单作业页**：上 3/4 是作业区，含「作业记录」「决策记录」两个内部页签；下 1/4 是交付件区。

这张页面是**只读看板**：不提供任何写入口。产线的全部推进——开始、完成、标记异常、质检结论——都由人在**左侧对话**里对 agent 说，由 agent 调用宿主侧工具完成。所以本需求的实现范围同时包含左侧的模型工具集：它不是后续增强，而是第一版的必经路径（右侧没有按钮，工具集不到位就没人能推进产线）。

实现走插件路线，`packages/` 与 `apps/` 零改动：新增一个双面插件包（宿主半 + 浏览器半）放在 `business-agent/plugins/dsh-plugin-workorder/`，用 `--patch` 覆盖层挂到 Profile 上。宿主半把业务系统收敛到一个可替换的适配器，对内提供 `workorder` 领域服务，对外是两个消费者——浏览器只读的 `/workorder/api/*`，以及模型用的工单工具集；浏览器半通过右侧栏公开的两段式注册路径（`ctx.sidebarRightTabs.register` + `ctx.slots.register`）成为右侧栏的只读页面类型。

业务系统对接第一版**不做认证**，先跑通接口；同时内置一份 mock 适配器，使 UI 与工具集都能在没有业务系统的情况下开发和验收。

「agent 操作后右侧如何同步」是页面实时性的唯一来源：第一版用轮询，SSE 已在宿主侧留好接口（`workorder.subscribe` 与 `/workorder/api/events` 是同一份变更流的两个消费者）。

## 业务背景

当前部署的 DSH Web 界面右栏是底座自带的「指南」页：展开后是一块罗盘，配两个入口胶囊（工作区文件、新终端）。它是通用编程场景的默认页，与工单作业无关。

业务侧的实际作业形态是一条**产线**：一个工单对应一条产线，产线由若干个按顺序排列的**活动**组成，每个活动是一种类型（工具 / agent / 手工 / 质检），各自的**输入件**来自上游活动的**输出件**。产线本身是会跑的——配成自动化的活动由产线自己取上游输出、自己执行、自己往下走；配成需人工的活动才停下来等人。执行过程中会失败或异常，这时要有人把输入或参数改掉，再让它重跑或续跑。

人现在要的是「这条线跑到哪了、卡在哪、产出是什么」一屏可见，以及在需要自己的时候有个介入的地方。现在这些信息散在业务系统里，用 agent 处理工单时要在对话和业务系统之间来回切屏，且没有一个地方汇总「这条产线产出了哪些交付件」。

## 目标与范围

**做什么**

- 右侧栏展开后的默认页面即工单作业页，不再是指南页。
- 页面上半部（作业区，约占 3/4 高）：竖排展示当前工单的产线活动；两个内部页签「作业记录」与「决策记录」。
- 页面下半部（交付件区，约占 1/4 高）：汇总展示这条产线所有活动的输出件。
- 活动卡片说清四件事：类型、**自动化标记**、状态、**每个输入件来自上游哪一步**。
- 状态区分「待开始」（还没轮到）与「等待人工」（轮到了但等人），后者是页面唯一喊人的状态。
- 页面是**只读**的：没有任何操作按钮，只有一句随当前活动变化的去向提示。
- **左侧对话是唯一的人工操作入口**：agent 通过工单工具集读产线、推进人工活动、给出质检结论，以及在自动活动失败后改输入并重跑或续跑；每次操作落一条决策记录。
- 宿主侧一个可替换的**业务系统适配器**与 `workorder` 领域服务；第一版提供 mock 与 HTTP 两个实现。
- 产线状态变化后右侧同步反映：活动状态、决策记录、交付件三处一起变。
- 挂载方式对上游可同步：不改 `packages/`、`apps/` 里的任何既有文件。

**不做什么**

- 不改左侧对话页的既有结构：消息流、输入框、审批条、文件链接的行为全部保持（工单工具以普通的工具调用卡片出现）。
- 不改 agent loop，不新增会话事件类型。
- **右侧页面不提供任何写入口**（没有开始/完成/异常/通过/驳回按钮）。这是刻意的：两套写入口会让权限、审计归属与「谁改的状态」都说不清。
- **不做产线编排**：产线结构、自动化标记、输入绑定都由业务系统给出。改绑定是让 agent 把改动写回业务系统，不是在本地编排，也不做可视化编辑（拖拽排序、增删活动）。
- 第一版不把产线状态注入系统提示词：agent 通过工具按需读取，不做常驻上下文——常驻会污染 KV 缓存，且工单状态在会话中途会变。
- 第一版不做认证与鉴权，不做多租户，不做工单的创建与删除（工单由业务系统产生）。
- 不做移动端适配；右栏在窄屏（<768px）下的全屏表现沿用底座既有规则。

## 术语与领域模型

| 术语 | 含义 |
|---|---|
| 工单 WorkOrder | 一次作业任务的载体，业务系统的主键是工单号 |
| 作业产线 Pipeline | 一个工单对应的一条有序活动序列 |
| 活动 Activity | 产线上的一步，类型为 工具 / agent / 手工 / 质检；每步另有一个「自动 / 需人工」的配置 |
| 自动化标记 | 产线配置里这一步由产线自己跑（auto），还是等人通过对话推进（manual）。与活动类型是两件事 |
| 输入件 / 输出件 | 活动开始所需的材料 / 活动完成后产出的材料 |
| 输入绑定 InputBinding | 一个输入件取自哪个上游活动的哪个输出件。不是产线一开始写死的清单，异常处置时可以改 |
| 交付件 Deliverable | 全部活动输出件的汇总视图，就是下半区展示的内容 |
| 决策记录 Decision | 一次操作的审计记录：谁发起（产线 / agent / 人 / 系统）、何时、对哪个活动、做了什么 |

```
WorkOrder 工单
  id, title, status(draft|running|blocked|done|cancelled)
  owner?, createdAt, updatedAt, currentActivityId?
  pipeline: Pipeline
  materials: ArtifactRef[]          工单级初始输入件（不属于任何活动的产出）

Pipeline 产线
  activities: Activity[]            有序

Activity 活动
  id, seq, type(tool|agent|manual|inspection), title
  automation: auto | manual         产线配置：这一步由产线自己跑，还是等人
  status: pending | waiting | running | done | failed | skipped
  inputs: InputBinding[]            上游输出件的绑定，可改
  outputs: ArtifactRef[]
  assignee?                         执行者：工具名 / agent 预设名 / 人工账号 / 质检员
  startedAt?, finishedAt?
  failure? { code, message }
  attempts?                         已尝试次数（产线自动重试后的值）

InputBinding 输入绑定
  name, kind(file|text|url|json|record)
  fromActivityId?                   取自哪个活动的输出；缺省表示工单级材料
  fromArtifactId?                   具体取哪个输出件；缺省按名称解析
  resolvedAt?                       解析成功的时刻；为空的绑定是「还没拿到输入」

ArtifactRef 件引用
  id, name, kind(file|text|url|json|record)
  source(workorder|activity|upload), activityId?
  uri                               业务系统 URL / 工作区文件地址 / dsh-resource:// 地址
  createdAt

Decision 决策记录
  id, at, actor(pipeline|agent|human|system), actorName?
  activityId?
  action(start|finish|fail|approve|reject|retry|resume|rebind|skip|note)
  reason?
```

**活动的状态机**（`waiting` 是这里的关键状态：轮到它了，但它是人工活动，产线推不动）

```
pending ──上游完成 + automation=auto────> running ──成功──> done
   │                                        └──失败──> failed
   │                                                     │
   │                                        人在对话里改输入后
   │                                        retry（重跑）/ resume（续跑）
   │                                                     ↓
   │                                                  running
   └──上游完成 + automation=manual──> waiting ──人在对话里下达──> running
```

**活动类型与自动化是两个正交的维度**：类型说的是这一步在做什么，自动化标记说的是这一步由谁触发。四个类型都可以出现在两种自动化标记下——「工具 + 需人工」是人工触发一次接口调用，「手工 + 自动」是人还没开口系统就先把材料备好。第一版不去限制组合，只按标记驱动。

| 类型 | 中文 | 典型自动化标记 | 说明 |
|---|---|---|---|
| `tool` | 工具活动 | auto | 产线直接调用宿主侧注册的工具（HTTP 调用、脚本） |
| `agent` | agent 活动 | auto | 产线把输入交给左侧会话里的模型跑一轮 |
| `manual` | 手工活动 | manual | 人在线下做完，通过对话报告结果 |
| `inspection` | 质检活动 | manual | 人给出通过 / 驳回结论，结论进决策记录 |

> 「之剑」已确认为「质检」。

## 右侧页面规格

整页在右栏内做上下分栏，高度比 3:1，中间一条 1px 分隔线；第一版固定比例，不做拖拽调节（右栏本身已经能通过底座的宽度手柄调宽）。

```
┌──────────────────────────────────────────────────┐
│ 作业区                                            │
│ ┌ 作业记录 ┬ 决策记录 ┐                           │
│ │ ① [工具] 拉取客户主数据        自动   已完成     │
│ │    输入 工单基本信息 → 输出 customer.json        │
│ │ ② [agent] 生成授信分析报告     自动   执行中     │
│ │    输入 ←① customer.json                        │
│ │ ③ [手工] 复核财报口径          需人工 等待人工   │
│ │    输入 ←② 授信分析报告.md                      │
│ │                                                │
│ │ 第 3 步需人工 · 对 agent 说「开始第 3 步」       │
│ └──────────────────────────────────────────────────┘
├──────────────────────────────────────────────────┤
│ 交付件区  来自活动 ①②③ …                         │
└──────────────────────────────────────────────────┘
```

**作业记录页签**：产线活动的竖排列表，按 `seq` 升序，每个活动是一张带轮廓的卡片，左侧一条导轨把它们串成产线（已完成的段是绿的、异常的段是红的）。卡片自上而下四段：

1. **头部**：序号圆点 + 类型徽章 + 标题 + 状态。
2. **自动化标记与执行者**：一个「自动」/「需人工」小胶囊，后面跟执行者与起止时间。标记必须单独显示——它与类型是两个正交维度，不能靠类型推断，用户扫一眼就要知道这一步产线会不会自己跑掉。
3. **输入件与输出件**：输入胶囊带 `←n` 前缀标明取自上游第几步的输出。异常处置时要改的就是这个绑定，所以来源必须看得见。
4. **异常原因**（仅异常活动）：错误码 + 说明 + 一行去处提示（「在左侧对话里改完输入后说「重跑第 n 步」或「继续执行第 n 步」」）。

**卡片上没有操作按钮**：这张页面不写状态，只读状态。当前活动（`currentActivityId`）的卡片轮廓换成强调色，异常时换成错误色。

**状态与颜色**：`待开始` 灰、`等待人工` 琥珀（页面唯一喊人的状态）、`执行中` 蓝、`已完成` 绿、`异常` 红。

**驱动提示条**：作业区底部一条常驻提示（不随产线滚走），内容随当前活动变化，四种形态——自动执行中说「第 n 步由产线自动执行中 · 无需操作」（安静，不喊人）；等待人工说「第 n 步需人工 · 对 agent 说「开始第 n 步」」；异常说「第 n 步执行失败 · 在左侧对话里改完输入后说「重跑第 n 步」或「继续执行第 n 步」」；其余说「产线推进中 · 当前第 n 步」。没有它，用户面对一个没有任何按钮的页面会不知道该去哪操作。

**决策记录页签**：只读时间线。每行给时间、发起方（产线 / agent / 人名 / 系统）、动作、活动，以及该次操作的说明。人工通过对话下达的指令以引号原样留档，产线自己跑的记录不带引号。数据来自 `GET /workorder/api/orders/:id/decisions`，按时间倒序。自动活动跑挂之后的处置、以及人给出的质检结论都在这里。因为操作都从对话发起，这一页同时是「agent 到底改了什么」的核对入口。

**交付件区**：全部活动输出件的扁平列表，每行给来源活动、名称、类型、产生时间与一个主操作。主操作按 `kind` 与 `uri` 分派：`uri` 指向本会话工作区文件时，用当前会话 id 拼出 `dsh-resource://file/session/<sessionId>/<path>` 并调用 `tab.actions.openResource(address)`，交给底座自带的文档查看器打开；`uri` 是外部地址时用新标签页打开；其余按纯文本预览。会话 id 由页面主体从 `useSession` / `sessionId` 取得，页面不自己维护。打开交付件是这张页面唯一的交互，它不改变任何状态。

**页面级状态**：加载中、加载失败（显示适配器给出的失败原因与「重试」）、空态（无工单时显示提示，mock 模式下给「加载示例工单」按钮）。切换到某个工单由页面内的工单选择器驱动，第一版用一个下拉框列出工单概要；工单数据来源见下节。这两种状态下的按钮是页面唯一的两个可点元素，都不写业务状态。

## 与业务系统的对接

| 项 | 内容 |
|---|---|
| 系统名称与地址 | 待澄清；由配置项 `baseUrl` 给出 |
| 接口形式 | HTTP / JSON（第一版）；适配器接口不假设协议，RPC / 数据库实现将来可替换 |
| 认证方式与凭据来源 | 第一版不认证。预留：Token 走底座的凭据链——`ctx.get('credentials')?.resolve(credentialRef(<tokenEnv>))`，解析层级为继承环境（只读）→ `$DSH_HOME/.credentials.yaml`（唯一可写）→ 调用目录 `.env` → `$DSH_HOME/.env`；配置项 `tokenEnv` 承载引用名，值不写进仓库，也不出现在任何页面文案里 |
| 关键字段与含义 | 见上文领域模型；与业务系统的字段映射由适配器负责，页面只认领域模型 |
| 调用频率与限流 | 页面加载时取一次，之后按 `pollIntervalMs`（默认 5000）轮询当前工单；agent 的写操作即时调用业务系统 |
| 失败重试与幂等 | 读操作失败即报错给用户，不自动重试；写操作全部发生在**模型工具**这一侧，由宿主半生成 `requestId`（UUID）随请求下发，业务系统按 `requestId` 幂等；写失败作为工具错误返回给模型，由模型决定重试还是报给用户，不自动重试 |

**适配器接口**（宿主半内部 seam，浏览器只读接口与 agent 工具集都只消费它）

```ts
interface WorkOrderAdapter {
  listOrders(query: { status?: string, q?: string, page?: number }): Promise<WorkOrderSummary[]>
  getOrder(id: string): Promise<WorkOrder>
  startActivity(orderId: string, activityId: string, cmd: ActivityCommand): Promise<Activity>
  finishActivity(orderId: string, activityId: string, cmd: ActivityCommand): Promise<Activity>
  failActivity(orderId: string, activityId: string, cmd: ActivityCommand): Promise<Activity>
  decide(orderId: string, activityId: string, cmd: DecisionCommand): Promise<Decision>
  listDeliverables(orderId: string): Promise<ArtifactRef[]>
  listDecisions(orderId: string): Promise<Decision[]>
  subscribe?(orderId: string, listener: (change: WorkOrderChange) => void): () => void
}
```

两个实现：`mockAdapter`（进程内内存态，带一份示例产线，供无业务系统时开发与验收）与 `httpAdapter`（把上表映射到业务系统的真实接口）。`subscribe` 可选，缺省时页面退化为轮询。

**宿主对浏览器暴露的 HTTP 接口**（前缀 `/api/workorder`）——**全部只读**。浏览器没有任何写路径，写操作一律经模型工具。

```
GET  /api/workorder/health
GET  /api/workorder/orders?status=&q=&page=&pageSize=
GET  /api/workorder/orders/:orderId
GET  /api/workorder/orders/:orderId/decisions
GET  /api/workorder/orders/:orderId/deliverables
GET  /api/workorder/events                    SSE，右栏实时更新用
```

每条写路径都必须在同一事务里追加一条决策记录，这是「决策记录」页签的唯一数据来源，也是审计口径；写入方只有工具集这一个。

**路由必须走 `ctx.connection.fetch.register({ path: '/api/workorder/…' })`，不能用 `ctx.webServer.register`。**

理由是一条安全事实，不是风格偏好：`WebServer` 的路由匹配是 **longest-prefix-wins**（`packages/host/webserver/src/index.ts:317-327`），而浏览器信任围栏与 cookie 鉴权只存在于连接层的 `/api` 前缀路由内部（`packages/client/connection/src/index.ts:128-135`）。于是：

- 用 `ctx.webServer.register({ kind: 'prefix', path: '/api/workorder' })` 会**因为前缀更长而赢过连接层的 `/api`**，请求根本不进围栏——**静默绕过信任检查与鉴权**。这是最容易犯且最难发现的错，因为它"能跑通"。
- `ctx.connection.fetch.register` 注册的路由在物理载体**已经施加信任与鉴权策略之后**才被调用，围栏与浏览器 cookie 鉴权全部自动获得，而且响应体是**逐块流式输出**的（`packages/client/connection/src/http-bridge.ts:83-110`），适合长连接。

本机 `dsh-plugin-inspector` 的注释写着「路由不能以 `/api` 开头，否则会被围栏接管」——那是保守约定，不是硬约束；真相是 `/api` **就是**围栏，正确做法是**加入**它（走 `connection.fetch`），而不是躲开它再用 `/workorder` 自建一条没有围栏的路。

### 产线自动执行由谁负责（已定：方案 A）

活动能自动执行，意味着产线在没人看着的时候也在往前走。这个「谁在走」有三种可能，架构完全不同：

| 方案 | 谁驱动 auto 活动 | 我们要做什么 | 代价 |
|---|---|---|---|
| **A. 业务系统自带产线引擎**（**已选定**） | 业务系统自己取上游输出、自己执行、自己推进状态 | 只读它的状态，加上异常处置的工具 | 输入绑定的动态解析逻辑在业务系统里，我们只是观察者；改绑定要调业务系统的接口 |
| B. 本插件做执行器 | 我们的 `workorder` 服务里跑一个 runner | 要额外做任务调度、并发控制、失败重试策略、进程重启后的恢复 | 复杂度大幅上升，而且和业务系统已有的产能重复 |
| C. 混合 | 工具类活动由业务系统跑，agent 类活动由本插件把输入投给会话里的模型跑 | 要做 agent 活动的调度 | 需要一套「会话被后台唤起」的机制 |

需求方在 2026-09-16 确认走 **A**。由此产生的一条新结论直接推翻了本文件早先按轮询设计的实时同步方案：产线会在没人操作的情况下变化，且单个活动可能跑几分钟到几小时，**轮询解决不了「agent 该在什么时刻醒过来」**。左右两侧的完整交互设计见 [0002](0002-conversation-pipeline-interaction.md)，本节只保留架构归属的结论。

**方案 A 的落点（同日两次追加澄清）**：「业务系统自带引擎」在代码上落成**工单服务自己的执行引擎**（`src/engine.js`）——服务之上没有另一层引擎。分辨方法：**引擎认产线结构、推状态机、判该不该喊人**（不换）；**执行实现把活动接过去跑、回执报结果**（`src/executor.js`，可单换）。

第二次澄清推翻了中间那一版画法：**不再单列「业务系统」这一层**——业务系统就是工单服务（今日是 mock 实现，真实部署由业务方提供同一套东西），接口在这边对齐、真实系统照做。于是 `state.upstream` 改名 `state.executor`：「上游」在领域模型里专指前序步骤，不該再兼职指「谁执行活动」。

对本文件的影响：页面仍然只读；但「页面怎么刷新」从轮询升级为宿主插件自建 SSE 推送，「agent 怎么被叫醒」由 0002 定义（`agent.followup` 投一条 notice）。

## 与 DSH 底座的对接（已核对的扩展点）

右侧栏的页面类型走两段式公开注册路径，`ui-sidebar-documentpreview` 与 `ui-sidebar-files` 是仓库内的现成样板，本插件走的是同一条路。

| 用途 | 扩展点 | 出处 |
|---|---|---|
| 声明页面类型（kind、标题、指南入口） | `ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })` | `packages/client/ui-sidebar-right/src/client/tab-registry.ts` |
| 注册页面主体 | `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <id>, locale, store, inject }, Body)` | `packages/client/ui-sidebar-right/src/client/contract/slots.ts` |
| 注册页签标题 | `ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: <id> }, Title)` | 同上 |
| 替换指南页体（备选方案） | `sidebar.right.tab.guide`（chain 槽；注册项返回 `null` 表示让位） | `packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx` |
| 默认页选择规则 | `defaultSeed()`：指南入口恰好 1 个时直接开该类型；0 个或多个时开指南页 | `packages/client/ui-sidebar-right/src/client/contract/seed.ts` |
| 宿主 HTTP 路由 | `ctx.webServer.register({ kind: 'prefix', path, handler })` | 本机 `dsh-plugin-inspector` 已实证 |
| 浏览器半入口 | `window.__ModuleLoader__.load({ id, factory })`，`id` 必须等于包名 | `packages/client/tsdown.client.ts` 的 banner/footer/intro |
| 挂载 | Profile 覆盖层 `--patch <file.yml>`，层序为 bundles → profile → `$DSH_HOME` → `--patch` | `apps/cli/src/plugin.ts`、本机 inspector 的 `mount.patch.yml` |
| 浏览器半可复用的共享模块 | `react`、`react-dom`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit` | `packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES` |

三条必须遵守的实现约束：

1. **跨插件只能通过 Cordis 服务与 slot 协作。** 浏览器半不得运行时 import 另一个功能插件的值（底座的 bundle purity 门禁会直接构建失败），也不得用 `dsh.client.external` 绕开；共享声明一律 `import type`（编译期擦除）。本插件的浏览器半因此**不 import** `dsh-client-ui-sidebar-right`——它只在类型层引用，运行时靠 `ctx.sidebarRightTabs` 服务与字符串 slot 名 `sidebar.right.pane.tab` 对接。
2. **产品文案必须走 locale 字典。** 所有可见文案（含按钮、无障碍名、空态、错误行）注册进 `ctx.locale.register(NS, { zh, en })` 并通过 `t` 读取，硬编码文案会被客户端 i18n 门禁拒绝。
3. **样式只用语义 token。** 通过 CSS Modules + `clsx` 消费 `--dsw-*` 语义别名，不写死颜色，不引入组件库。

**双面插件的 inject 来源不同，不能按同一套写。**

| 半边 | 谁读 inject | 写法 |
|---|---|---|
| 宿主半 | 模块的 `export const inject` 与行上的 `inject:` 是**并集**，不是二选一：Loader 在 `internal/plugin` 钩子里把 `EntryOptions.inject` 累加进 fiber 已有的 inject | 两处都写：模块里 `export const inject = ['webServer']`，覆盖层行上也写 `inject: [webServer]` |
| 浏览器半 | 浏览器侧只按 `loader.create({ name })` 建行（`packages/client/web/src/boot-client.ts`），行上没有 inject 可传，**只能**来自模块命名空间 | 模块里 `export const inject = ['slots', 'locale', 'sidebarRightTabs']` |

`dsh.client.inject`（包名数组）是另一回事：它是模块图/预检/HMR 用的**包名**边，不参与服务等待。建议在其中列出 `@deepseek-ai/dsh-client-ui-sidebar-right`，与 `ui-sidebar-files`、`ui-sidebar-documentpreview` 的写法一致。

**两个会让插件静默失效或直接崩的模块形状陷阱：**

1. **两个半边都绝不能有 `default` 导出。** Loader 的 `unwrapExports` 会把模块解析成 `exports.default ?? exports`，一旦存在 default，整个命名空间被丢掉，导出的是裸函数——`inject` 与 `name` 全部丢失，读服务随即抛 `cannot get property "…" without inject`。本机那个 `dsh-plugin-inspector` 正好踩了这个坑，只是它的浏览器半 inject 为空所以现在看不出来；照抄它会写不出工单页。宿主半同理：命名导出 `name` / `inject` / `apply`，不写 `export default`。同类事故有官方 postmortem：`docs/postmortem/0001-acp-default-export-drops-inject.md`。
2. **声明了 `dsh.client` 就必须有 `exports["./client"]`。** 扫描期缺它会直接抛（`client-modules: … declares dsh.client but exports no "./client" bundle`），且 `clientPath` 由包根路径直接拼接，不走 Node 的条件解析。

另外两条来自底座、会影响产品表现的事实，需要在 UI 设计时接受：

- 右栏状态是**内存态且按会话隔离**，刷新页面后回到折叠默认页；没有会话时（hero 屏）右栏不存在。因此页面必须能从零自行恢复：默认选中适配器返回的第一条工单，或按 URL/会话状态恢复上次工单（第一版按前者）。
- 右栏的展开/收起、宽度、全屏表现全部由底座既有逻辑决定，本插件不参与，也不改。

## 挂载与默认页方案

要把「展开即工单作业页」做成事实，需要同时决定挂载方式和默认页来源。两条可选路径：

**方案 A（推荐）：注册独立页面类型 + 让工单页成为唯一指南入口**

- 注册 kind 为 `workorder` 的页面类型，并给它**唯一一个**指南入口。
- 在覆盖层里把 `ui-sidebar-files`、`ui-sidebar-terminal` 两行 `disabled: true`。这两个包各自贡献了一个指南入口（`packages/client/ui-sidebar-files/src/client/definition.tsx` 的 `guide: [{ id: 'workspace', order: 10, ... }]`、`packages/client/ui-sidebar-terminal/src/client/index.ts` 的 `guide: [{ id: 'new', order: 20, ... }]`），去掉后全表只剩本插件这一个入口，`defaultSeed()` 就会直接开 `workorder` 类型。
- 结果是：展开右栏即工单作业页，页签标题正确显示「工单作业」，关闭与去重语义都由底座按普通页面类型处理。

**方案 B：只替换指南页体**

- 不注册新类型，改为向 chain 槽 `sidebar.right.tab.guide` 注册一个选择器，让它接管指南页体。默认页本来就是指南页（当前有两个入口，`defaultSeed()` 落到指南），因此展开右栏看到的就是工单页。
- 不改任何现有行，代价是页签标题仍是指南的「指南」文案，且指南页被整体接管后，工作区文件与新终端两个入口不再出现，需要在工单页里自建入口才能保留（调用 `tab.actions.openTab('files')` / `openTab('new')`）。

推荐方案 A。理由是工单作业页需要一个正确的页签身份（标题、关闭行为、未来的多实例语义），而方案 B 会把「指南」这个身份留在标签上。

方案 A 的代价是把 `ui-sidebar-files`、`ui-sidebar-terminal` 两个行停掉后，文件树页与新终端页**整体消失**，不是隐藏入口——终端不会再有恢复入口。对话里的文件链接不受影响，仍能打开文档查看器，因为 `ui-sidebar-documentpreview` 是独立行，且它自己认领 `dsh-resource://file/**` 地址。如果确认要保留这两个页面类型，改走方案 B，并在工单页顶部保留一个入口条（`tab.actions.openTab('files')` / `openTab('new')`）。

两方案都必须走覆盖层，不得编辑 `packages/client/ui-sidebar-files`、`packages/client/ui-sidebar-terminal` 本身。覆盖层里按 id 停行不需要重述行名，写法与 `packages/bundle/web-app/cordis.patch.yml` 里停 `tool-bash` 的方式一致。

覆盖层内容（方案 A）大致如下，具体配置字段以实施时的代码为准：

```yaml
# business-agent/workorder.patch.yml —— Profile 覆盖层，也是本插件唯一的挂载入口

- insert:
    - id: workorder
      name: dsh-plugin-workorder
      # 行上的 inject 与模块里的 export const inject 取并集，两处都写最稳
      inject: [webServer]
      config:
        mode: mock            # mock | http
        baseUrl: ''           # http 模式必填
        tokenEnv: WORKORDER_TOKEN
        timeoutMs: 10000
        pollIntervalMs: 5000

# 让工单作业页成为唯一的指南入口，从而成为右栏展开后的默认页
- id: ui-sidebar-files
  disabled: true
- id: ui-sidebar-terminal
  disabled: true
```

**这份覆盖层文件不吃热重载。** `patchReload: live` 只 watch profile 自己的 `cordis.patch.yml` 与 `$DSH_HOME/cordis.patch.yml` 两个精确路径，`--patch` 传入的文件不在其中——改它必须重启进程。需要边改边看时，把同样的内容写进 `$DSH_HOME/profiles/web/cordis.patch.yml`（`web` profile 的 `patchReload` 是 `live`），验证完再挪回仓库内的固定覆盖层。

**覆盖层的实际层序**是 bundles → `$DSH_HOME/profiles/<name>/cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`（按 argv 顺序，后到者覆盖先到者）→ 遥测禁用行。最后那一行优先级高于 `--patch`，排查「我的覆盖没生效」时要知道它在。覆盖层的定位按 id 生效：目标行不存在只告警不失败，`config` 是**整块替换**而非深合并，所以覆盖我们自己的行时要把整个 config 重述一遍。

**浏览器半被扫进 `__DSH_BOOT__` 的六个前置条件**（缺任何一条都是启动期失败或整行消失，M1 就按这份清单排查）：

1. 该行被某个 patch 挂上且不是 `disabled`（扫描遍历的是 Loader 的活动行，不是 node_modules）；
2. `package.json` 声明 `dsh.client.platform === 'web'`；
3. `package.json` 有 `exports["./client"]`（缺了直接抛错）；
4. 该导出指向的构建产物真实存在；
5. 产物自带 `window.__ModuleLoader__.load({ id, factory })` 包装，且 `id` 等于包名；
6. 行名与包名一致（HMR 也按这个找行）。

不需要 `dsh.bundle` 声明，也不需要进 workspace——但仓库的客户端门禁同样**不校验树外包**，写错只会在启动时以 FAILED fiber 爆出来。

## Agent 视角

> **本节已被 [0002](0002-conversation-pipeline-interaction.md) 大幅收缩。** 需求方确认业务系统已经提供 MCP 工具、且 AI 直接调用它们，因此下面这 10 个自建工具**全部作废**：查询与推进由业务系统自己的 MCP 工具承担，本插件只保留「消费 WebSocket 事件、把进度写进对话、需要人时唤醒」。保留这一节是为了记录取舍过程，实施时以 0002 为准。

这一节是第一版的核心：右侧没有任何写入口，产线的推进完全由这些模型可见内容承担。

**工具集**（注册进宿主 `tools` 注册表，落在 Profile 覆盖层顶层 insert 的全局层）

| 工具 | 参数 | 返回给模型的东西 |
|---|---|---|
| `workorder_list` | `status?`, `q?`, `page?` | 工单概要列表：工单号、标题、状态、当前活动 |
| `workorder_get` | `orderId` | 整条产线：每个活动的序号、类型、标题、自动化标记、状态、执行者、输入绑定（含来自哪一步）、输出件、异常原因与已尝试次数 |
| `workorder_start_activity` | `orderId`, `activityId`, `note?` | 人工活动的开始；该活动的新状态 |
| `workorder_finish_activity` | `orderId`, `activityId`, `note?`, `outputs?` | 人工活动的完成；新状态与新增的交付件 |
| `workorder_decide` | `orderId`, `activityId`, `decision: approve \| reject`, `note?` | 质检结论与该活动的新状态 |
| `workorder_bind_input` | `orderId`, `activityId`, `bindingId`, `fromActivityId`, `fromArtifactId?` | 改掉一条输入绑定；重新解析后的绑定 |
| `workorder_retry_activity` | `orderId`, `activityId`, `reason?` | **重跑**失败的活动（从头再来）；新状态 |
| `workorder_resume_activity` | `orderId`, `activityId`, `reason?` | **续跑**失败的活动（从断点继续）；新状态 |
| `workorder_fail_activity` | `orderId`, `activityId`, `code?`, `message` | 由人判定为异常；新状态与失败原因 |
| `workorder_skip_activity` | `orderId`, `activityId`, `reason` | 跳过后的产线状态 |

工具集的重心在**异常处置**而不是常态推进：自动化活动由产线自己往下走，agent 不需要（也不应该）逐步替它按按钮；agent 的价值在于「失败之后把输入改对、再让它跑起来」。

设计约束（都来自底座规则，不是偏好）：

- 工具注册用 `ctx.tools.register(defineTool({...}))`，**注册即 effect**，插件卸载自动注销。`parameters` 的每个属性自带 `required: true`；`execute` 返回的是 `output.schema` 声明的规范 JSON 值，`output.render(args, value)` 才产出给模型看的 content blocks；`execute` 必须转发 `exec.signal`。`run_code` 是保留工具名。
- **模型可见 ⟺ 可被日志重建**：工具调用与结果由 agent loop 自动落进会话日志，不需要额外事件。这是第一版不新增任何会话事件类型的原因。
- 返回给模型的内容是**状态**而不是页面结构：只说「第 3 步现在是已完成，产出 X」，不出现卡片、徽章、页签这类界面词汇。
- 工具描述要写清两条：推进产线前先 `workorder_get` 确认当前活动与它的自动化标记（否则模型会去推一个产线自己会跑的活动）；改绑定与重跑是不可逆的写操作，要先把改动内容说给用户确认。

**不做的两件事**（第一版明确排除）

- **不注册提示词段落**。产线状态会随操作变化，做成常驻上下文既污染 KV 缓存，又会在会话中途变成过期事实；agent 按需调 `workorder_get` 读。
- **不新增会话事件类型**。工具调用已经满足「可被日志重建」，没有第二种模型可见输入的刚需。

**已核对的底座事实**（第一版就会用到，不是后续预研）

- **作用域**：Profile 覆盖层顶层 insert 的工具行落在**全局层**，Web 会话的 agent **看得见**——工具可见性解析永远把全局层并入，preset 层只是更近的祖先，同名才遮蔽。所以工单工具放覆盖层即可，不必改任何 preset。
- **模式**：`tools` 的 `mode` 默认 `native`（web 上被 `process.env.DSH_TOOLS_MODE` 覆盖）。`native` 下模型直接看到这组工具；切到 `ptc`/`both` 后模型只看到 `run_code`，工具改为在生成的 SDK 里可达——部署时若开了 PTC，交互形态会变，验收要按照当前 `mode` 来跑。
- **凭据**：`ctx.get('credentials')` 拿到 `CredentialProvider`，用 `credentials.resolve(credentialRef(<tokenEnv>))` 读取；解析层级是继承环境（只读）→ `$DSH_HOME/.credentials.yaml`（唯一可写）→ 调用目录 `.env` → `$DSH_HOME/.env`。注意凭据文件权限只隔离操作系统用户，tool 进程以同一用户运行，**凭据文件对模型不是安全边界**——所以哪些活动允许 agent 自行推进，要在工具描述与业务系统权限两侧一起限。
- **生成物不含树外插件**：`docs/tool-catalog.md` 由脚本从 `packages/*/tool-*` 生成，树外插件注册的工具不会出现在里面，别指望那份目录能自证。
- **验证路径尚未被端到端覆盖**：仓库没有测试覆盖「树外包只装在 profile 的 node_modules + `--patch` 挂载 + `dsh.client` 扫描」这条组合，M1 必须真起一次服务并在浏览器里看 `globalThis.__DSH_BOOT__.entries`，不能只靠单测。

## 交付物与目录结构

> 分层已在 [0003](0003-left-right-system-split.md) 定案：工单服务不 import 任何 DSH 的东西，右栏只走 wire 拿数据，DSH 那部分只是适配器。下面的目录按 0003 的三层组织。

```
business-agent/
  plugins/dsh-plugin-workorder/
    package.json                  # name / exports . 与 ./client / dsh.client.platform = web / files
    src/service/                  # ① 工单服务：不 import 任何 DSH 的东西
      domain.js                   #   工单/产线模型与状态折叠
      business-ws.js              #   连业务系统的 WebSocket，断线重连
      store.js                    #   状态缓存与事件流
      bindings.js                 #   绑定表：clientId ↔ 工单
      wire.js                     #   主机中立的 HTTP + SSE 面
    src/adapter/                  # ② DSH 适配器：唯一与 DSH 耦合的一层
      index.js                    #   把 wire 挂到 /api/workorder（connection.fetch.register）
      progress.js                 #   事件 → 会话进度行（session.append user/message）
      wake.js                     #   需要人时 agent.followup
      observe-tools.js            #   从 MCP 工具调用里提取绑定
    src/pane/                     # ③ 右栏渲染层：只走 wire 拿数据
      index.tsx                   #   类型注册 + 页面主体
      *.tsx                       #   作业区 / 决策记录 / 交付件区 / 驱动提示条
      locales.ts
    lib/index.js / lib/client.js  # 构建产物（浏览器半为 CJS + __ModuleLoader__ 包装）
    tsdown.config.ts
  workorder.patch.yml             # Profile 覆盖层：insert 本插件行、disable 内置右栏页类型
  prototype/workorder-pane.html   # 纯前端布局原型，不参与构建
  start-dev.ps1                   # 增加 -Patch 参数（默认带 workorder.patch.yml）
```

浏览器半必须打包：它是 CJS 工厂形态，需要把 TSX 编成 `React.createElement`，并按 `packages/client/tsdown.client.ts` 的写法套上 `window.__ModuleLoader__.load({ id, factory })` 包装、把 `PLATFORM_MODULES` 里的名字保留为 external。宿主半可以不打包（纯 ESM `.js` 直接跑，与 inspector 插件同形），也可以一起走 tsdown。

打包有一个必须验收的产物约束：源码两侧都不写 `default` 导出，且**构建产物里不能出现 `exports.default` / `module.exports.default`**——ESM 源码经 CJS 打包很容易被 interop 补出一个 default，补上就等于触发上文那个丢命名空间的坑。产物里应只有 `name` / `inject` / `apply` 三个导出。

依赖解析有两种选择，实施前需确认：把 `business-agent/plugins/*` 加进 `pnpm-workspace.yaml` 的 packages 列表（一行新增，仍不动 `packages/` 与 `apps/`，可直接复用根 `node_modules` 里的 react、tsdown、typescript），或让插件自带 `package.json` 与独立 `npm install`。推荐前者。

## 里程碑

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| M0 定架构 | ~~确认「产线自动执行由谁负责」~~ 已定方案 A；改为确认 [0002](0002-conversation-pipeline-interaction.md) 里的唤醒策略与绑定方案 | 0002 的「唤醒后 agent 该怎么做」「绑定怎么重建」两条落定 |
| M1 骨架 | 插件包、覆盖层、mock 适配器、空页面能挂上右栏并成为默认页 | 展开右栏看到标题为「工单作业」的空页面；刷新后重新展开仍是它 |
| M2 只读作业区 | 活动卡片（含自动化标记与输入来源）、状态色、交付件区、决策记录页签、四态驱动提示条 | 用 mock 数据看到完整产线，页面上没有任何写入口 |
| M3 工具集 | `workorder` 服务 + 10 个模型工具，走 mock 适配器 | 在左侧对话里能读产线、推进人工活动，并把一条失败的绑定改掉重跑 |
| M4 实时同步 | 轮询（M0 选 B/C 时直接上 SSE），产线或 agent 改动后右侧自动刷新 | 不手动刷新页面，产线自己推进一步后右侧三处一起变 |
| M5 HTTP 适配器 | 接真实业务系统，错误与超时处理 | 切 `mode: http` 后 M2/M3/M4 的场景在真实系统上复现 |
| M6 打磨 | 空态、失败态、窄栏、深色、键盘可达性 | 验收标准全绿 |

## 验收标准

- [ ] `powershell -File business-agent\start-dev.ps1 -ReplaceExisting` 启动后，在 `http://127.0.0.1:3081` 展开右栏，看到的默认页是工单作业页，页签标题为「工单作业」。
- [ ] 工单作业页上半部为作业区（含「作业记录」「决策记录」两个可切换页签），下半部为交付件区，两块高度比约为 3:1。
- [ ] 作业记录页签按 `seq` 顺序列出 mock 产线的全部活动，每张卡片显示序号、类型、**自动化标记**、标题、状态、执行者与起止时间。
- [ ] 每个输入件胶囊带 `←n` 前缀，`n` 指向真正产出它的那个上游活动的序号；来自工单级材料的输入不带前缀。
- [ ] 状态色区分五种状态：`待开始` 灰、`等待人工` 琥珀、`执行中` 蓝、`已完成` 绿、`异常` 红；「等待人工」与「待开始」在视觉上不会混。
- [ ] **页面里没有任何写业务状态的控件**：活动卡片上没有按钮；仅有的可点元素是两个空态/失败态占位按钮与交付件行。
- [ ] 作业区底部常驻一条驱动提示，且四种形态都对：自动执行中显示「无需操作」；等待人工显示可以照说的那句话；异常显示「改完输入后重跑或继续」；其余显示产线推进中。提示不随产线滚动移出视野。
- [ ] 在左侧对话里说「看一下这个工单的产线」，agent 调用 `workorder_get`，工具卡片出现在消息流里，右侧内容与工具返回一致。
- [ ] 在左侧对话里说「开始第 3 步」，agent 调用 `workorder_start_activity`，该活动由 `等待人工` 变为 `执行中`，决策记录新增一条发起方为 agent、带对话原话的记录。
- [ ] 在左侧对话里说「第 4 步合规有异议，驳回」，agent 调用 `workorder_decide`，活动变为异常、决策记录出现 `reject` 记录且带上说明。
- [ ] 对一个自动化活动，在对话里说「把第 5 步的输入换成第 3 步的复核结论」，agent 调用 `workorder_bind_input` 后，卡片上的 `←n` 前缀随之改变；决策记录留下这次改动。
- [ ] 对一个失败的活动，在对话里说「重跑第 2 步」，agent 调用 `workorder_retry_activity`，活动回到 `执行中`，异常原因消失；说「继续执行第 2 步」走 `workorder_resume_activity`。
- [ ] 决策记录页签按时间倒序列出全部操作，每条能看出**发起方**（产线 / agent / 人名 / 系统）与对应的活动；产线自己跑的记录不带引号，人通过对话下达的带引号。
- [ ] 交付件区列出全部活动的输出件，来源活动可辨认；对工作区文件类交付件点击后，右栏打开底座的文档查看器并显示该文件内容。
- [ ] 在覆盖层里把插件行的 `config.mode` 改为 `http` 且 `baseUrl` 指向一个不可达地址，页面显示失败态与业务系统的失败原因，并提供可用的「重试」；此时对话里调用工具，agent 收到的是工具错误而不是会话崩溃。
- [ ] 左侧对话页在以上全部操作前后结构不变：消息流、输入框、审批条、文件链接的形态与改造前一致（工单工具以普通工具调用卡片出现）。
- [ ] `git status` 显示 `packages/` 与 `apps/` 下没有任何改动。
- [ ] 把覆盖层内容临时移进 `$DSH_HOME/profiles/web/cordis.patch.yml` 后，改 `config.mode` 不重启进程即生效（`web` profile 的 `patchReload` 是 `live`，但它不覆盖 `--patch` 文件）。
- [ ] 重启后 `globalThis.__DSH_BOOT__.entries` 里能看到 `dsh-plugin-workorder` 一行，且浏览器控制台没有 `cannot get property … without inject` 报错。
- [ ] 两个构建产物里都搜不到 `exports.default` / `module.exports.default`。
- [ ] 按当前 `tools.mode` 验证工具确实对模型可见：`native` 下工具出现在会话的工具清单里；若部署开了 `ptc`/`both`，则在 `run_code` 的 SDK 里可达。

## 待澄清问题

- [ ] **产线自动执行由谁负责？**→ 结论：**已定方案 A**（业务系统自带产线引擎）。左右两侧的交互设计见 [0002](0002-conversation-pipeline-interaction.md)。
- [ ] 自动化活动的输入绑定解析失败时算哪种状态？→ 结论：待确认；建议复用 `failed`（原因写 `INPUT_UNRESOLVED`），而不是新加一个状态。
- [ ] 「重跑」与「续跑」对业务系统是不是两个不同的接口？→ 结论：待确认；本文件把它们设计成两个工具，但如果业务系统只有一个「重新执行」，就砍掉 `workorder_resume_activity`。
- [ ] 自动化活动失败后业务系统自己会不会重试？重试几次？→ 结论：待确认；决定 `attempts` 字段的来源，以及页面上要不要显示「已重试 2 次」。
- [ ] 「之剑」这一类活动到底指什么？→ 结论：已确认指「质检」，活动类型为 工具 / agent / 手工 / 质检。
- [ ] 业务系统的接口形态与字段？→ 结论：待给出接口文档或样例响应；本文件已把映射收敛在适配器里，字段变化不影响页面与工具。
- [ ] 工单从哪来、页面如何选中要作业的工单？→ 结论：第一版默认取适配器返回的第一条工单，并在页面内提供工单选择器；是否需要「按当前会话绑定工单」待定。
- [ ] 是否需要保留「工作区文件」与「新终端」两个右栏页面类型？→ 结论：待确认；选「保留」则默认页方案改走 B（见上节）。
- [ ] **哪些活动允许 agent 自行推进？**→ 结论：待确认。右侧没有按钮之后这是唯一的人工闸门：要么在工具描述里限定（例如质检活动必须由人明确下达结论才允许写），要么靠业务系统的权限。第一版不认证，等于全开。
- [ ] 工具调用的确认边界：agent 直接改业务系统状态是否需要走底座的审批（approval）机制？→ 结论：待确认；会影响工具是否需要声明为需要审批的一类。
- [ ] `business-agent/plugins/*` 是否加入 `pnpm-workspace.yaml`？→ 结论：已确认加入。
- [ ] 产线是否需要实时刷新，还是按需刷新？→ 结论：待确认；若需要，走 `/workorder/api/events` 的 SSE，否则按 `pollIntervalMs` 轮询。
- [ ] 一个会话是否可能对应多条工单？→ 结论：待确认；影响页面顶部选择器，以及 agent 调工具时是否要带 `orderId`（当前设计里工具显式带 `orderId`，不受影响）。

## 决策记录

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-09-16 | 右侧页面采用「独立页面类型 + 唯一指南入口」方案 A，而非替换指南页体 | 工单作业页需要自己的页签身份；替换页体会把「指南」标题留在标签上 |
| 2026-09-16 | 第一版不做认证 | 需求方明确「先不认证，先跑通接口」；认证插入点已在适配器与配置项上预留 |
| 2026-09-16 | 业务系统对接收敛到一个可替换的适配器，并内置 mock 实现 | 字段与协议尚未确认，mock 让 UI 与验收不被业务系统阻塞 |
| 2026-09-16 | 插件放 `business-agent/plugins/`，用 `--patch` 覆盖层挂载 | 需求方选定；`packages/` 与 `apps/` 零改动，便于与上游同步 |
| 2026-09-16 | ~~第一版不注册任何模型可见内容~~（已被下方「右侧页面改为纯只读看板」推翻，保留以记录取舍过程） | 「对话驱动产线」方案当时未定；避免先落一个会被推翻的工具契约 |
| 2026-09-16 | 修正三处早期误判：`--patch` 文件不吃 `patchReload: live`；宿主半的 inject 是「模块导出 ∪ 行上声明」的并集；浏览器半不得出现 `exports.default` | 逐条核对源码后确认，参考插件 `dsh-plugin-inspector` 的挂载注释在这三点上有两处归因错误、一处结论错误；照抄会写出一个 inject 全丢的浏览器半 |
| 2026-09-16 | 右侧页面改为纯只读看板，不提供任何写入口；产线的全部推进由左侧对话里的 agent 调用工具完成，工单工具集进入第一版必经路径 | 需求方明确「当前活动不需要手动启动结束完成，所有操作通过左侧对话进行」。由此也去掉了双写入口带来的权限与审计归属问题；代价是工具集从可选项变成 M3 的硬依赖 |
| 2026-09-16 | 浏览器侧的 `/workorder/api/*` 收敛为只读，写路径只保留工具集一条 | 页面不写状态之后，POST 接口没有任何消费者；少一条写路径就少一处审计与幂等要维护的地方 |
| 2026-09-16 | 不注册提示词段落，agent 按需调 `workorder_get` 读状态 | 产线状态随操作变化，常驻上下文会污染 KV 缓存并在会话中途变成过期事实 |
| 2026-09-16 | 「之剑」确认为「质检」；`business-agent/plugins/*` 加入 `pnpm-workspace.yaml` | 需求方确认 |
| 2026-09-16 | 活动模型加入三个维度：**自动化标记**（auto/manual，与类型正交）、**状态**加 `waiting`（轮到它但等人）、**输入改为来自上游输出的绑定**（`InputBinding` 带 `fromActivityId`，可改） | 需求方澄清「产线活动本身可以自动化执行，取决于产线的配置……给这些活动打上自动化标记。有些活动需要人来进行的。每个活动的输入都是之前活动输出的一个或者几个，不一定一开始就设置死的」。绑定可改正是异常处置的落点，所以它必须是一等字段而不是注释 |
| 2026-09-16 | 工具集重心从「逐步推进」改为「异常处置」，新增 `bind_input` / `retry_activity` / `resume_activity`，删去自动活动上的常规推进 | 自动化活动由产线自己走，agent 逐步替它按按钮既没意义也会和产线引擎抢状态 |
| 2026-09-16 | 驱动提示条改为四态，自动执行中显示「无需操作」而不喊人 | 页面是给「需要我的时候」用的；自动执行中也喊人会让人以为处处都要盯着 |
| 2026-09-16 | 页面与工具的实时同步仍按轮询设计，SSE 留接口 | 是否升级到 SSE 取决于「产线自动执行由谁负责」这个未决项：业务系统自带引擎时轮询够用 |
| 2026-09-16 | 方案 A 的落点明确为：**执行引擎就在工单服务里**（`src/engine.js`），服务之上没有「引擎层」 | 需求方澄清「在真实系统中这个服务本身就是执行引擎」。上层留着的只有可换的执行侧（当时叫 `src/upstream.js`）；此前的图画成「引擎在服务上面、demo 结束后被换掉」，会把不换的东西画成要换的。同步落地实现，自检 15 项 |
| 2026-09-16 | **不单列「业务系统」这一层**：业务系统就是工单服务，今日是 mock 实现；接口在 workorder 这边对齐，真实业务系统照做；`state.upstream` 改名 `state.executor` | 需求方澄清「不该有业务系统，业务系统就是工单服务，当前是 mock 的工单服务，相当于实际的业务系统」「当前在 workorder 对齐的接口，后续在真实业务系统上都应该有」。上一行的图仍把业务系统画成服务外面的一个框，等于把同一个东西画成两层；改名是因为「上游」在领域模型里已经专指前序步骤，一个词不能再兼两义 |
