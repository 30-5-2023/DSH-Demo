> **已归档：这是讨论存档，不要作为设计依据。当前设计只有一份 → [../../DESIGN.md](../../DESIGN.md)**

# 0002 左侧对话与右侧产线的交互设计

## 基本信息

| 项 | 内容 |
|---|---|
| 编号 | 0002 |
| 标题 | 左侧对话与右侧产线的交互设计 |
| 提出人 | 本仓库二次开发需求方 |
| 记录时间 | 2026-09-16 |
| 状态 | 澄清中 |
| 关联特性 | F-002（见 [../FEATURES.md](../FEATURES.md)） |
| 前置 | [0001 右侧浏览页替换为工单作业页](0001-workorder-execution-pane.md)（方案 A：业务系统自带产线引擎） |

## 当前结论

0001 把右侧做成了只读看板，操作都从左侧对话走。但只靠「页面轮询 + 用户主动问」撑不起这个设计：**产线会在没人操作的情况下变化，而且一个活动要跑几分钟到几小时**。所以交互设计的核心不是「怎么同步数据」，而是**「agent 怎么在正确的时刻自己醒过来」**。

底座已经有这条通道，不需要新造：宿主插件可以对一个**活着的**会话调用 `agent.followup()`，投一条消息并唤醒它；这条消息用 `source.kind: 'plugin'` + `form: 'notice'` 声明来源和形态，在对话里渲染成一行**上下文提示**而不是用户气泡（`ui-chat/.../message.ts:55`：任何 `source.kind !== 'user'` 的消息都走上下文节点）。

于是分工是：

- **拉**（模型工具）：用户问的时候取当前状态。所有工具**立即返回**，绝不等待活动跑完。
- **推**（`followup`）：产线需要人的时候把人叫来。投递策略照抄 `tool-jobs` 的**有界主动唤醒**——空闲才开新轮，忙时只搭车，并设连续唤醒预算防自激。
- **右栏**：宿主插件缓存业务系统状态，通过自建 SSE 推给浏览器半，不使用会话投影（理由见下）。

整个过程不需要新增会话事件类型：唤醒就是一条普通的 `user/message`，`source` 说明它是谁塞进来的。

## 为什么轮询解决不了

不是「轮询拿不到数据」，是三个具体问题：

1. **轮询没有「时刻」的概念。** 页面每 5 秒问一次业务系统，拿到的永远只是最新状态；而 agent 需要的是一个**事件**才能在没人要求的情况下开始一轮。让 agent 自己去轮询（定时调 `workorder_get`）更糟：每张工单会持续产生空转轮次，烧 token、把会话历史塞满「我查了一下，还是没变」。
2. **长活动不能同步等。** 一个跑两小时的活动，如果工具阻塞到它结束，那个 turn 就被占两小时——用户插不上话、上下文窗口被占、连接断了就全丢。所以工具一律「提交并返回」，结果靠唤醒回来。
3. **`waiting` 是人不在场时的状态。** 产线停在「等待人工」，如果没人正好盯着右栏，这件事就一直是死的。唤醒是把这条线接回人的唯一办法。

## 底座提供的通道（已逐条核对）

### 通道一：唤醒一个活着的会话

```ts
agent.followup(createUserMessage({
  content: [{ type: 'text', text: '…' }],
  source: { kind: 'plugin', plugin: 'workorder', form: 'notice', summary: '第 3 步等待人工' },
}))
```

| 事实 | 出处 |
|---|---|
| `followup(message)` = `send(message, 'next-turn', true)`：排进收件箱并唤醒驱动器；这条消息成为**它自己那一轮的唯一普通消息** | `packages/core/agent-loop/src/agent.ts:137-139`；`packages/core/agent/src/runtime-types.ts:217-222` |
| 唤醒**不会打断正在跑的轮次**，输入等到 agent 回到 idle 才被取走 | `runtime-types.ts:204-215` |
| `inject(message)` = `send(message, 'next-step', false)`：进下一步上下文但**不唤醒**；idle 的 agent 会一直挂着它 | `agent.ts:145-147`；`runtime-types.ts:236-238` |
| `runMaintenance(task)` 在 agent 非空闲时**同步抛异常**（`already has active work`） | `agent.ts:157-158` |
| 安全取空闲相位的做法是 `whenIdle()` → `runMaintenance()` → 在相位内 `followup()`，Schedule 就是这么做的 | `packages/schedule/schedule/src/runtime.ts:252-304` |
| 只对**活着的根 Agent**有效；冷会话收不到任何东西 | `packages/schedule/schedule/README.md`（Session-local delivery only） |
| **`followup()` 返回 `void`**，只表示已入队，**不代表模型处理了**、也不代表工单推进了 | `docs/subsystems/core.md`；`runtime-types.ts:217-222` |

### 唤醒的投递策略（照抄 `tool-jobs`，别自己发明）

仓库里已经有一套产品化验证过的「有界主动唤醒」，就在 `tool-jobs` 的作业完成通知里（`packages/jobs/tool-jobs/src/index.ts:278-299`）。它解决的是和我们一模一样的问题：**一个后台东西跑完了，怎么把 agent 叫起来，又不把它叫疯**。直接对齐它的形状：

| agent 状态 | 投递方式 | 效果 |
|---|---|---|
| `idle` 且预算未耗尽 | `followup()` | 立即开一轮 |
| `running`（正在处理别的） | `inject()` | 搭车进下一步，**不新开一轮、不打断** |
| 连续唤醒已达预算上限 | `inject()` | 降级：不再主动开轮，等用户下一条消息把预算重置 |

**为什么忙时必须用 `inject` 而不是 `followup`**：`followup` 在 agent 正在跑的时候会**排一个新轮次**——当前轮结束后又开一轮。产线事件密集时这会变成「agent 处理一条，又开一轮，又处理一条」，把会话烧穿。`inject` 只把通知放进下一步的上下文里，是搭车不是叫醒。

**预算**：`tool-jobs` 用 `maxConsecutiveWakes`（默认 3）限制连续主动唤醒的次数，且预算**只由真人输入重置**——它监听 `agent/inbox/claimed`，只有 `message.source.kind === 'user'` 才清零（`packages/jobs/tool-jobs/src/index.ts:224-228`）。

这一条对我们尤其重要，因为存在**自激循环**：唤醒 → agent 调工具推进产线 → 产线状态变化 → 又唤醒。预算 + 「只有真人说话才重置」是这套循环的刹车，不是可选的优化。

### 宿主半的骨架

```ts
// workorder 服务收到一条「需要人」的产线事件
function wakeForPipelineEvent(ctx: Context, sessionId: SessionId, event: LineEvent): void {
  if (!needsHuman(event)) return                     // 自动活动的中间态只推右栏，不进对话
  if (!claimDedupeKey(event)) return                 // (orderId, activityId, toStatus, occurredAt) 已投过
  const agent = ctx.agents.get(sessionId)            // 拿不到活 Agent 就攒着，绝不 resume
  if (agent === undefined) { queuePending(sessionId, event); return }

  const message = createUserMessage({
    content: [{ type: 'text', text: renderNotice(event) }],
    source: { kind: 'plugin', plugin: 'workorder', form: 'notice', summary: summarize(event) },
  })
  // 照抄 tool-jobs：空闲且有预算才主动开一轮，否则搭车进下一步
  const spent = spentWakes.get(agent) ?? 0
  if (agent.status === 'idle' && spent < WAKE_BUDGET) {
    spentWakes.set(agent, spent + 1)
    agent.followup(message)
  } else {
    agent.inject(message)
  }
}

// 预算只由真人输入重置
ctx.on('agent/inbox/claimed', ({ agent, message }) => {
  if (message.source.kind === 'user') spentWakes.delete(agent)
})
```

### 通道二：这条消息在对话里长什么样

| 事实 | 出处 |
|---|---|
| `source.kind !== 'user'` 的消息一律渲染成**上下文节点**，不是用户气泡 | `packages/client/ui-chat/src/client/conversation-nodes/message.ts:55-63` |
| `kind: 'plugin'` 的产出者标签取 `source.plugin`，角色是 `inject` | `packages/client/ui-chat/src/client/conversation-nodes/event-projection.ts:69-70` |
| `form: 'notice'` 渲染成一行折叠提示，文案取 `source.summary` | `packages/client/ui-chat/src/client/chat/ContextBody.tsx:569-574` |
| `form: 'notice'` 这个判别式**强制要求** `summary` 字段 | `packages/llm/llm/src/message.ts:90-94` |
| `MessageSourceMap` 是可合并扩展的，外部事件有自己的 `kind` 是既定做法（webhook 包就这么干） | `packages/llm/llm/src/message.ts:98-107`；`packages/webhook/webhook/src/types.ts:71-83` |

所以唤醒在对话里的样子是一行安静的东西：

```
workorder · 第 3 步「复核财报口径」等待人工，输入已就绪
```

模型读到的正文由 `content` 决定，`form`/`summary` 只影响呈现——两件事分开。

### 通道三：右栏怎么实时更新

先把底座的推送版图说准（都是核对过的）：

- **应用数据的推送通道只有一条**：`/api/remote.mux` 单条 WebSocket，跑 Typert Remote stream（`packages/api/gateway/src/stream-protocol.ts:6`）。会话控制流（含投影帧、后台任务帧）都走它。
- **全仓唯一真实的 SSE 端点**是 HMR 的 `GET /plugins/events`（`packages/client/hmr/src/index.ts:158-200`）——它就是「第三方在自己路由上开 SSE」的现成模板。
- **没有浏览器轮询**。`ctx.remote.$on(event)` 的事件转发是编译期白名单 + 单一所有者（`packages/api/remotes/src/remote-events.ts:17-38`、`packages/api/gateway/src/index.ts:242-244`），树外追加不了。

我们有两条路，报告的打分是「自有 SSE 补实时细节、投影补需要被记住的状态」：

| | A. 自有 SSE | B. 会话投影（`ctx.sessionProjections`） |
|---|---|---|
| 改动量 | 小：一个宿主路由 + 浏览器一个 `EventSource` | 中：三处声明合并 + Zod schema + 纯 fold + **每次变更都要 `session.append` 一条事件** |
| 是否动 `packages/` | 不用 | 不用 |
| 围栏与鉴权 | 走 `connection.fetch.register` 挂在 `/api` 下则**自动获得** | 自动（复用 `/api/remote.mux`） |
| 重连与补帧 | 完全自负：无基线、无重连、无补帧 | **最强**：重连先发 baseline，逐帧 higher-seq-wins，还有持久化投影缓存 |
| 左侧会话能否也看到 | 否 | **能**（同一事件已进日志） |
| 客户端代码 | 手写订阅 | **零**——`control.ts` 广播投影帧时没有 key 白名单（`packages/api/session-controller/src/control.ts:26-42`），新键自动到达 |

**投影的致命约束**：它的驱动源**只有** `session/event`（`packages/session/session-projection/src/index.ts:220-222` 是 `drive()` 的唯一调用点）。产线引擎在没有 agent 事件的情况下改了状态，**投影不会动**。所以要用投影，就必须把每次产线变更写成一条**log-only 的会话事件**（照 `'model/selection'` 的写法，标注「永不进入模型历史」）。

**第一版选定：自有 SSE（走 `connection.fetch.register` 挂 `/api/workorder/events`），不写会话事件。** 理由：

1. 产线状态是**业务系统**的状态。为它往每个盯单会话的日志里追加事件，等于把别人的状态抄进我们的日志；一张单被 5 个会话看着就抄 5 份，漂移和体积都是白付的。
2. 新增 `SessionEventMap` 成员默认是 **required-on-read**，不认识它的构建会**拒绝整个日志**（除非标 `ignorable`）。对「底座零改动、可同步上游」的 fork 这个代价太大。
3. 报告把这一项标为「未能确认」：在 turn 之外 `session.append` 自定义事件是否会被拒（已知无 open turn 时某些 dispatch 会抛），第一版不值得押在这上面。

**代价要写清楚**：右栏的实时状态**只有右栏能看到**，左侧会话与其它 UI 拿不到同一份变更。这不是遗漏，是刻意的取舍——左侧要感知产线，走的是通道一的唤醒（产线需要人时 agent 被叫醒），而不是让左侧持续订阅一份它用不到的高频状态。哪天真需要「左侧也实时显示产线」，再把那条 log-only 事件补上，届时投影与 SSE 可以共存：SSE 负责高频纯展示的细节（进度、当前工步），投影负责低频、需要被记住与重放的状态迁移。

`jobsBySession` 不是这条线的样板：它是 `SessionControlFrame` 的并列成员 `'jobs'`，不是投影；想复制它必须改 `packages/api/session-controller`（`.agents/notes/implemented/feature/2026-08-08-web-background-job-display.md` 明确拒绝过把它做成投影）。

## 进度怎么进左侧对话（已定）

需求方明确了真实场景：**用户说「启动工单，输入文件是 xxx」，工单自动执行，每一步都在左侧展示**——「步骤1已执行完成，步骤2已启动……所有活动执行完成，输出件是 xxx」。这比 0002 早先的「只在需要人时唤醒」宽得多：**中间态也要出现在对话里**。

于是「展示」和「唤醒」必须分成两件事，否则 20 个活动就是 20 轮模型对话：

| 机制 | 能进对话流吗 | 会唤醒 AI 吗 | 进模型历史吗 | 结论 |
|---|---|---|---|---|
| `agent.inject(msg)` | **不能**：只进收件箱，显示在输入框的待发队列里，不是对话记录 | 否 | 是（下次被 claim 时） | 否——语义错了，进度不该像"待发送的消息" |
| `agent.followup(msg)` | 能（notice 行） | **是** | 是 | 否——每步一轮模型对话，又贵又吵 |
| `session.append('user/message', msg, { surfaceOp: 'append' })` | **能**，立即出现 | **否** | 是 | **选定** |
| 自定义 log-only 会话事件 + 自定义渲染器 | 能 | 否 | 否 | **做不到**，见下 |

**选定的做法**：直接往对话面追加一条 `user/message`，来源声明成插件 notice。

```ts
agent.session.append('user/message', createUserMessage({
  content: [{ type: 'text', text: '✅ 步骤 1「拉取客户主数据」已完成，产出 customer-master.json' }],
  source: { kind: 'plugin', plugin: 'workorder', form: 'notice', summary: '步骤 1 已完成' },
}), { surfaceOp: 'append' })
```

这不是绕路，是底座明确支持的用法。`packages/core/session/tests/invariant.spec.ts:156-169` 有一条专门的用例，注释就写着 *idle context*：

```ts
const outside = (await setup()).ctx.sessions.create()
expect(() => outside.append('user/message', createUserMessage({
  content: [{ type: 'text', text: 'idle context' }],
  source: { kind: 'plugin', plugin: 'test' },
}), { surfaceOp: 'append' })).not.toThrow()
```

好处是**客户端一行代码都不用写**：`source.kind !== 'user'` 的消息本来就渲染成上下文行（`ui-chat/.../message.ts:55`），`form: 'notice'` 那一支自带一行折叠摘要（`ContextBody.tsx:569`）。

**必须认的代价**：每条进度都**进入模型历史**，模型每轮请求都要读一遍。所以：

- 进度文案要短（一行、含步骤号与产出件名即可），不要贴长文本。
- 不要为每个中间态都发（例如"输入解析中"这种瞬时态），只发**状态迁移**：开始、完成、失败、等待人工。
- 如果实测膨胀得厉害，退路是**用 `surfaceOp` 的替换语义把上一条进度就地改写**，让整条产线在对话里只占一行、持续更新（这就是早先问过的「进度条」形态）。第一版按需求方选的「一行行日志」做。

**为什么不能走自定义会话事件**（这是个不容易发现的死路，记下来免得重走）：

1. `Session.append()` 的类型签名是 `append<T>(type, data, ...opts: T extends SurfaceEventType ? [opts] : [])`——**非 surface 事件根本没有传 opts 的位置，因此写不了 `ignorable: true`**。全仓没有任何生产代码给 append 设过这个标记，它只出现在测试与读路径里。
2. 而持久化读路径会用 `KNOWN_SESSION_EVENT_TYPES` 校验日志，遇到不认识、又没标 `ignorable` 的类型，**直接拒绝解释整个日志**（`packages/session/session-persistence/src/storage-contract.ts:75`）。
3. 那份名单是**生成物**，来源是 `packages/*/*` 的声明（`packages/core/session/src/known-event-types.ts:1-22`，注明 "GENERATED … do not edit by hand"）。我们的插件在 `business-agent/plugins/`，**进不了这份名单**。

三条合起来：**树外插件写自定义会话事件，会让这个会话在之后任何一次读取时被拒绝**。所以进度只能走现成的 `user/message`。

## 会话 ↔ 工单的绑定：从 MCP 工具调用里读

需求方定了「AI 直接调业务系统的 MCP 工具」，并指出「AI 知道工单 id，把 id 传给 MCP 工具就知道对应关系」。这条路能成立，是因为**MCP 工具调用本身是一条普通的工具调用，落在调用它的那个会话的日志里**。

插件不需要包装工具，只需要**旁观工具执行**：

```ts
// exec 带 agent、name、arguments（ToolExecution 的公开字段）
ctx.on('tools/result', (exec) => {
  const agent = exec.agent
  if (agent === undefined) return
  if (!exec.name.startsWith(`mcp__${serverName}__`)) return
  const orderId = readOrderId(exec.arguments)   // 按配置的字段名取，见下
  if (orderId === undefined) return
  bind(agent.session.id, orderId)               // 会话 ↔ 工单
})
```

- 事件名与签名：`'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>)`（`packages/core/tools/src/index.ts:191`）；`'tools/post-execute'` 同样携带 `exec`（同文件 `:169`）。`ToolExecution` 有 `callId` / `name` / `arguments` / `agent`。
- **参数里哪个字段是工单号，由配置给**：MCP 工具的参数 schema 来自业务系统，插件猜不得。配置项形如 `orderIdArg: 'orderId'`（每个关心的工具一项）。
- **一个必须知道的副作用**：MCP server 返回的 `instructions` 会被**自动注入系统提示词**（`packages/mcp/mcp-client/src/connection.ts:318-322` 组装成 `### MCP server: <name>`，`server-context.ts:32-38` 注册成段落）。这与 0001「不注册提示词段落」的理由（状态会变、污染 KV 缓存）直接冲突。两条路：要求业务系统的 MCP server 把 instructions 留空，或者接受它。
- **绑定可以跨重启重建**：工具调用是持久事件，会话恢复时从日志里那条 `tool/call` 重放即可，不需要另存一份。

## MCP 与 WebSocket 的分工（已定）

需求方说右侧工单执行有两种现成接口：WebSocket 和 MCP 工具。调研的裁决是**它们不是二选一，而是两条不同方向的通道**：

| | 方向 | 承担 |
|---|---|---|
| **WebSocket** | 业务系统 → 我们（推） | **事件面**：活动的开始/完成/失败。MCP 结构上做不到这件事——DSH 的 MCP 桥只把「工具列表变了」翻译成一次重同步，**服务端主动消息一律丢弃**（`packages/mcp/mcp-client/src/connection.ts:262-270`，生产代码没有第二个通知出口） |
| **MCP 工具** | AI ↔ 业务系统（拉） | **工具面**：查询工单、启动工单、推进活动。工具名会是 `mcp__<serverName>__<rawName>`（`packages/mcp/mcp-client/src/tools.ts:81-87`），描述与参数 schema 由业务系统决定 |

推论：**0001 里那 10 个自建模型工具全部作废**。查询与推进由业务系统自己的 MCP 工具承担，我们的插件只做三件事：消费 WebSocket 事件、把进度写进对话、在需要人时唤醒 AI。这是一次实打实的瘦身。

如果哪天业务系统只给 MCP 不给 WebSocket，实时推送就只能降级成「宿主侧按间隔轮询 MCP 工具」——发生在服务端，页面仍然是推的，与 0001 否掉的**页面轮询**不是一回事。

## 交互时序：一张工单的完整生命周期

```
业务系统执行活动 ──(WebSocket)──> 工单服务（执行引擎在这里推状态机）
                                          │
                                          ├─ ① SSE 推给右栏
                                          ├─ ② 需要人时唤醒 agent
                                          └─ ③ 追加决策记录
```

引擎归属见 [0001](0001-workorder-execution-pane.md) 的「方案 A 的落点」：执行引擎在工单服务里，不在服务之上。业务系统只把活动的执行结果回执过来。

| 时刻 | 发生了什么 | 插件做什么 | 对话里看到什么 |
|---|---|---|---|
| T0 | 用户说「打开工单 WO-014」 | agent 调 `workorder_open`，建立**会话 ↔ 工单**绑定 | 工具卡片 + agent 一句概述：「5 步，①②已完成，③等你处理」 |
| T1 | 业务引擎跑 ②（auto，20 分钟） | 只推右栏，**不唤醒**（自动活动不需要人） | 无 |
| T2 | ② 完成，③ 进入 `waiting` | 判定「需要人」→ `followup` 一条 notice | 一行上下文提示：「第 3 步复核财报口径等待人工」；agent 开一轮把情况说明 |
| T3 | 用户说「把 2025 年报也贴进去，开始第 3 步」 | agent 调 `workorder_bind_input` + `workorder_start_activity`，**立即返回** | 工具卡片 + 右栏 ③ 变为 `执行中` |
| T4 | ③ 跑完 | 只推右栏（③ 之后是 ④，manual） | 下一轮唤醒会带 ④ |
| T5 | ⑤ 自动活动失败 | `followup`：「第 5 步归档失败 UPSTREAM_TIMEOUT，已重试 2 次」 | 一行提示；agent 给出处置建议 |
| T6 | 用户说「换成第 3 步的复核结论再试」 | agent 调 `workorder_bind_input` + `workorder_retry_activity` | 右栏 ⑤ 回到 `执行中`，异常原因消失 |

整条线上**用户只在 T0/T3/T6 说话**，中间产线自己走；agent 在 T2/T5 自己醒过来。

## 唤醒策略

- **默认只唤醒「需要人」的状态**：`waiting` 与 `failed`。自动活动的推进、以及一切中间态都只推右栏，不进对话——否则一条 20 步的产线会在对话里刷出 20 条提示。
- **去重**：同一活动在同一个状态上只唤醒一次。去重键取 `(orderId, activityId, toStatus, occurredAt)`；业务系统重复投递同一条事件是常态（webhook 包明确写着「No built-in deduplication — rules that own idempotency」），幂等必须自己做。
- **合并**：会话不在线期间攒下的事件，在会话回来时**合并成一条**（「你不在的时候：③ 完成、④ 等待人工、⑤ 失败」），不是 n 条。
- **可订阅**（可选，第一版可缓）：`workorder_watch(orderId, events)` 让 agent 显式声明它还想知道什么，覆盖默认策略。没有它之前，agent 想知道中间态就在需要时调 `workorder_get`。

## 工具形态：长活动不能占住一个 turn

工具由业务系统的 MCP 提供，我们不再自己写，但有一条**必须跟业务系统对齐的约定**：**没有任何工具会等待活动跑完**。

- 「启动工单」「推进活动」这类工具必须是「提交并返回」——返回提交后的状态（通常是 `running`），不返回结果。
- 结果通过 WebSocket 事件回来，再落成进度行或唤醒。
- 如果业务系统的 MCP 工具是同步等待到活动结束才返回，那么一个跑两小时的活动会把一个 turn 占两小时：用户插不上话、上下文窗口被占、连接断了全丢。**这条要写进对接验收**。

## 离线与恢复

- **会话不活着 → 不投递。** 与 Schedule 的边界一致：不往会话外面发任何东西（没有邮件、推送、浏览器通知）。
- 事件记为 pending，下次该会话 `agent/created`（`source: 'resume'`）时补送，并**合并成一条**。
- 用户回来后第一眼应该能分清「这条提示是刚发生的，还是我离开期间攒的」——合并消息里带时间范围。

**明确不调用 `ctx.agents.resume()` 去把冷会话拉活。** 虽然这条 API 存在（`packages/core/agent/src/index.ts:407`），但用它意味着：

1. `resume` 会真的把会话拉活——挂载 agent preset、解析模型选择、打开持久化会话写入。这是一个**用户没要求**的重动作。
2. 返回的 `AgentHandle` **归调用方所有**：`dispose()` 会停掉并注销这个会话。于是插件和 Web 自己的会话管理器**同时拥有**这个 Agent，谁来释放是说不清的。
3. Schedule 的边界也是这条：不唤醒冷会话，等它被 resume 时再补投。

所以第一版只投递给 `ctx.agents.get(sessionId)` 拿得到的**活 Agent**，拿不到就攒着。

## 投递 ≠ 处理

`followup()` 返回 `void`，只表示消息已同步入队（`runtime-types.ts:217-222`）。它**不承诺**模型会处理、更不承诺工单会被推进。所以：

- 插件绝不能把「唤醒投递成功」当成「这件事有人管了」，也不要把投递写进决策记录当成一次操作。
- 决策记录里的「人/agent 做了什么」只能来自业务系统的真实状态变化，不能来自我们自己投过消息。
- 想知道人是不是真响应了，唯一可靠的办法是看产线状态有没有动——这也是页面存在的意义：它是唯一的事实来源。

## 安全：业务系统来的文本一律不可信

照抄 Schedule 的措辞方式（`packages/schedule/schedule/README.md` 的 reminder framing）：唤醒消息把业务系统的文本（活动标题、失败原因、件名）当**不可信内容**传入，正文里明确写出这一条，不要把外部文本拼成指令。

原因很实在：失败原因这类字段由业务系统写入，可能来自上游数据，甚至来自另一个模型。如果它被当成指令，就等于给了外部系统一条往 agent 上下文注入命令的通道。

## 待澄清问题

- [ ] **唤醒后 agent 该怎么做？**→ 结论：待确认。两种取向：(a) 只把情况转告用户并等指令（安全，但用户还要再说一句）；(b) 允许 agent 自行处置（高效，但它会自己改业务系统状态）。本文件默认按 (a)，用工具描述与唤醒正文里的一句约束兜住。
- [ ] **agent 改业务系统状态要不要走底座的审批？**→ 结论：待确认。如果走对话是唯一入口，人工确认也应该收敛到对话里的审批条，而不是回到右栏开个口子。这决定工具是否需要声明为需要审批的一类。
- [ ] **绑定怎么跨重启重建？**→ 结论：待确认。推荐从会话日志里的 `workorder_open` 调用重放；需要验证一个第三方插件能不能方便地读会话日志的最近若干事件。
- [ ] **`connection.fetch.register` 的 SSE 端到端没实测过。**→ 结论：待验证。`http-bridge` 的实现是逐块 `res.write` 并处理背压与断连（`packages/client/connection/src/http-bridge.ts:83-110`），理论上支持长连接，但没人验证过 SSE 帧会不会被缓冲到连接关闭才发出。验证办法：注册一条返回 `text/event-stream` 的 `ReadableStream` 路由，用 `curl -N` 看首帧延迟，再用带 cookie 的浏览器 `EventSource` 确认缺 cookie 时返回 401。**这是 M1 的第一个实验**。
- [ ] **`workorder/changed` 这类 log-only 会话事件在 turn 之外能不能 `append`？**→ 结论：待确认（已知无 open turn 时某些 dispatch 会抛）。第一版不用它，但如果将来要让左侧也实时看到产线，这是唯一的路，届时要先做这个实验。
- [ ] **业务系统能不能推事件给我们（SSE / WebSocket），还是只能我们拉？**→ 结论：**已定能推**（需求方确认有 WebSocket），推的是**活动粒度**。字段细节待敲定：需要一份样例消息才能定「怎么映射成步骤n 完成/启动/失败」。这是当前最需要材料的一条。
- [ ] **MCP 工具的参数里哪个字段是工单号？**→ 结论：待确认。绑定靠从工具调用参数里读工单号，但参数 schema 由业务系统决定，插件猜不得——需要一份 MCP 工具清单（工具名 + 参数名）。
- [ ] **业务系统的 MCP server 会不会返回 `instructions`？**→ 结论：待确认。若会，它将被自动注入系统提示词，与 0001「不注册提示词段落」的理由直接冲突。要么让业务系统留空，要么接受。
- [ ] **`tools/result` 拿到的 `exec.agent` 在 MCP 工具调用时是否一定非空？**→ 结论：待验证。绑定完全依赖它；若为空则要退回「扫会话日志里的 `tool/call`」这条更重的路。
- [ ] **`dsh web` 里关掉标签页后 Agent 会不会被销毁？**→ 结论：待确认，且**影响设计**。如果 Agent 长期冷着，「产线在半夜需要人」这类场景就只能攒到用户下次打开；如果 Agent 常驻，唤醒随时可达。验证办法：开一个会话 → 关标签页 / 切到别的会话 → 宿主侧记录 `ctx.agents.get(sessionId)` 是否变为 `undefined`。
- [ ] **一张工单会不会被多个会话盯着？**→ 结论：待确认。会影响唤醒是「叫醒所有绑定会话」还是「叫醒一个」。
- [ ] `workorder_watch` 第一版做不做？→ 结论：待确认；不做的话 agent 想知道中间态只能主动查。

## 决策记录

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-09-16 | 交互设计的核心定为「agent 怎么在正确的时刻自己醒过来」，而不是「怎么同步数据」 | 需求方指出「光靠轮询同步很难让左侧 agent 按设计进行，因为一个活动需要执行很长时间」；轮询没有时刻概念，长活动也不能同步等 |
| 2026-09-16 | 用底座的 `agent.followup()` 唤醒会话，不新造唤醒机制 | 逐条核对源码确认这条通道存在且语义合适；Schedule 包已在这条路上跑通，空闲相位与去重做法可直接照抄 |
| 2026-09-16 | 唤醒消息用 `source.kind: 'plugin'` + `form: 'notice'` | `kind !== 'user'` 的消息在对话里渲染成上下文提示行而不是用户气泡（`ui-chat/.../message.ts:55`），产线事件不该冒充用户说话；`notice` 形式自带一行摘要，正合「告诉你出事了」这个用途 |
| 2026-09-16 | 右栏实时更新走宿主插件**自建 SSE**，挂在 `/api/workorder/events`，**不使用会话投影、不写会话事件** | 会话投影的驱动源只有 `session/event`，要用它就得把每次产线变更追加进会话日志——那是把业务系统的状态抄进我们的日志，且要新增 required-on-read 的 `SessionEventMap` 成员。代价要认：右栏的实时状态只有右栏看得到，左侧感知走的是唤醒而不是订阅 |
| 2026-09-16 | 唤醒消息的 source 用 `kind: 'plugin'` + `plugin: 'workorder'`，第一版不自定义 `MessageSourceMap` 成员 | 自定义 kind 是既定做法（webhook / subagent-settled / agent-message 都这么做）且不需要新增会话事件类型；但 `plugin: 'workorder'` 已经能在日志里一眼区分「产线塞的」，没必要为此多做一个模块扩展 |
| 2026-09-16 | 所有模型工具一律「提交并返回」，绝不等待活动结束 | 一个跑两小时的活动不能占住一个 turn：用户插不上话、上下文被占、连接断了全丢 |
| 2026-09-16 | 默认只唤醒 `waiting` 与 `failed`，中间态只推右栏 | 否则一条 20 步的产线会在对话里刷出 20 条提示，把会话变成日志流 |
| 2026-09-16 | 幂等自己做，键取 `(orderId, activityId, toStatus, occurredAt)` | 底座明确不提供去重（webhook 包：No built-in deduplication），而业务系统重复投递是常态 |
| 2026-09-16 | 投递策略照抄 `tool-jobs` 的有界主动唤醒：idle → `followup`，忙 → `inject`，配连续唤醒预算，且预算只由真人输入重置 | `tool-jobs` 的 `onJobDone`（`packages/jobs/tool-jobs/src/index.ts:278-299`）是本仓库对「异步事件唤醒 agent」最成熟的产品化实现，形态与我们完全一致。忙时用 `followup` 会排队新开轮次，产线事件密集时会把会话烧穿；而唤醒 → agent 行动 → 产线再变 → 再唤醒构成自激循环，预算不是可选优化而是刹车 |
| 2026-09-16 | 不调用 `ctx.agents.resume()` 拉活冷会话 | 一是重动作（挂 preset、解析模型选择、打开持久化写入），用户没要求；二是返回的 `AgentHandle` 归调用方所有，插件会与 Web 的会话管理器同时拥有同一个 Agent，归属说不清。Schedule 的边界也是「不唤醒冷会话」 |
| 2026-09-16 | 明确「投递 ≠ 处理」，插件的任何状态都不以「投递成功」为准 | `followup()` 返回 `void`，只表示入队；把投递当成「有人管了」会让决策记录说谎。唯一的事实来源是业务系统的真实状态 |
| 2026-09-16 | 路由用 `ctx.connection.fetch.register` 挂在 `/api` 下，**绝不用 `kind:'prefix'` 注册 `/api/...`** | `WebServer` 匹配是 longest-prefix-wins，`/api/workorder` 会赢过连接层的 `/api`，请求不进围栏——**静默绕过信任检查与鉴权**。挂在 `/api` 下反而自动获得围栏与 cookie 鉴权，且响应体逐块流式输出 |
| 2026-09-16 | 浏览器半订阅 SSE **不需要 inject 任何服务** | `EventSource` 是浏览器全局，cookie 由浏览器自动携带；HMR 的浏览器半订阅 `/plugins/events` 就是这个形状 |
| 2026-09-16 | **进度行不走自定义会话事件**，走现成的 `user/message` + `source.kind:'plugin'` + `form:'notice'`，用 `session.append(..., { surfaceOp: 'append' })` 直接追加 | 自定义事件这条路在树外被三重堵死：`append()` 没有传 `ignorable` 的位置；持久化读路径遇到不认识且非 ignorable 的类型会**拒绝整个日志**；那份类型名单是生成物、只收 `packages/*/*`。走 `user/message` 还白得一套现成的 notice 行渲染，客户端零代码。代价是进度进模型历史，所以文案要短、只发状态迁移 |
| 2026-09-16 | 会话 ↔ 工单的绑定**从 MCP 工具调用里读**，不包装工具 | 需求方定了「AI 直接调 MCP 工具」。MCP 调用是一次普通工具调用，落在调用它的会话日志里；插件订阅 `tools/result`，从 `exec.agent` 拿会话、从 `exec.arguments` 按配置的字段名拿工单号。绑定因此是持久的，重启后可从日志重放 |
| 2026-09-16 | 0001 里自建的 10 个模型工具**全部作废**，查询与推进交给业务系统的 MCP 工具 | 业务系统已经提供 MCP 工具，再自建一套等于重复实现，而且两套工具名会在「有 MCP / 无 MCP」的部署下不一致，破坏「模型可见 ⟺ 可被日志重建」的稳定性。插件收缩到三件事：消费 WebSocket 事件、把进度写进对话、需要人时唤醒 |
| 2026-09-16 | 事件面只能用 WebSocket，不能用 MCP | DSH 的 MCP 桥只把「工具列表变了」翻译成一次重同步，服务端主动消息一律丢弃（`packages/mcp/mcp-client/src/connection.ts:262-270`，生产代码没有第二个通知出口）。业务系统无法用 MCP 告诉我们「第 3 步进入 waiting 了」 |
