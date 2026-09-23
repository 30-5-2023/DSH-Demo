# A2A 桥接实现计划

[English](2026-09-20-a2a-bridge-implementation.md) | 中文

> **供智能体工作者使用：** 必须使用子技能 `superpowers:executing-plans`，逐项实施本计划。

**目标：** 新增一个 Business Agent 插件，对外暴露一个 A2A Protocol v1.0 智能体，并注册 `call_a2a_agent` 工具，通过对方的 Agent Card URL 调用其他智能体。

**架构：** 私有 Express 应用承载官方 A2A SDK 处理器，并通过现有 `ctx.webServer` 挂载；持久化存储域将 A2A 上下文和任务映射到普通 DSH Session；按上下文串行的调度器与 Session 事件跟踪器将每个 A2A 请求转换成一个精确关联的 DSH turn。出站路径使用带边界 fetch 实现的 SDK 客户端，返回紧凑、模型可见的结果。

**技术栈：** TypeScript、Cordis、`@a2a-js/sdk` 1.2.0、Express 5.2.1、`@types/express` 5.0.6、Zod/Schemastery、Node 测试运行器、DSH 录制 Session 快照。

**已批准设计：** [A2A 桥接设计](../specs/2026-09-20-a2a-bridge-design.zh.md)

## 全局约束

- 必须在真实 Git 检出中实施。当前复制的工作区没有 `.git`；在恢复仓库元数据或将工作移入正式检出前，不得开始任务 1。
- 所有产品代码都放在 `business-agent/` 下；不得修改 `packages/` 或 `apps/`。
- 只实现 A2A v1.0 JSON-RPC：Agent Card、`SendMessage`、`SendStreamingMessage`、`GetTask` 和 `CancelTask`。
- 每个进程暴露一张可配置的 Agent Card。不得增加注册中心、出站凭证、推送通知、任务列表、重新订阅、文件、媒体、gRPC 或 HTTP+JSON。
- 每个 A2A `contextId` 映射到一个持久 DSH Session。同一上下文内串行执行，不同上下文之间允许有上限的并发。
- 默认只监听回环地址。当 `ctx.webServer.host` 为 `0.0.0.0` 时必须配置非空 Bearer token；Agent Card 保持公开，仅保护 `/a2a`。
- 允许直接访问内网 HTTP(S) Agent Card URL。拒绝内嵌凭证、fragment、HTTPS 降级到 HTTP 的重定向、过多重定向、超时和超过配置上限的响应体。
- 日志不得记录 Authorization 值、完整远端响应体、完整提示词、推理或工具调用。只记录稳定关联标识和安全错误摘要。
- 内部边界使用品牌化 id，启用严格 TypeScript；所有注册都使用 Cordis effect，卸载时等待完全静默。
- 每个实现切片都先写失败测试，观察指定失败，再加入最小代码，观察指定通过，然后提交该切片。

## 审查重点

批准实现前必须审查以下五类故障。后续任务为每一类都加入明确测试。

1. 首次响应完成前收到相同 `messageId`，可能产生两个 Task 或重复提示 Session。`request-handler.test.mjs` 必须在屏障处暂停首次执行，提交重试，并断言只有一个 Task id、一次 Session prompt 和两个等价协议响应。
2. SSE 断开可能取消或遗失底层 Task。`server.test.mjs` 必须在收到 `working` 后销毁流客户端，放行 Agent，再通过 `GetTask` 取得已完成任务。
3. 取消竞态可能取消无关 turn 或写入两个终态。`execution.test.mjs` 必须覆盖排队中、执行中、已终止，以及取消与完成竞态，并断言只有一次终态转换。
4. Host 重启可能使 `submitted` 或 `working` Task 永远保持活动。`store.test.mjs` 必须重新打开同一存储根，将中断任务标记为带 `A2A_HOST_INTERRUPTED` 的失败，保留已结束任务，并继续使用上下文原有 Session id。
5. 重定向、超大响应、畸形 Data Part 或无效的 JSON 输出可能进入模型或泄露远端内容。`conversion-safe-fetch.test.mjs` 必须断言它们在接纳前失败、诊断有长度边界且 Session prompt 次数为零。

## 文件地图

创建插件包：

- `business-agent/plugins/a2a-bridge/package.json` — 包边界与精确运行时依赖。
- `business-agent/plugins/a2a-bridge/tsconfig.json` — 仅 Host 的项目引用。
- `business-agent/plugins/a2a-bridge/tsdown.config.ts` — Node 2024 ESM 包，并将 DSH 包外置。
- `business-agent/plugins/a2a-bridge/src/types.ts` — 品牌化 id、持久记录、公开客户端结果与内部端口。
- `business-agent/plugins/a2a-bridge/src/config.ts` — Schemastery schema 与部署感知校验。
- `business-agent/plugins/a2a-bridge/src/card.ts` — 单张经过校验的 A2A v1.0 Agent Card。
- `business-agent/plugins/a2a-bridge/src/store.ts` — 存储域仓库与 SDK `TaskStore` 适配器。
- `business-agent/plugins/a2a-bridge/src/conversion.ts` — Part 转换、严格 JSON 输出与安全失败。
- `business-agent/plugins/a2a-bridge/src/safe-fetch.ts` — 超时、重定向、协议与字节上限。
- `business-agent/plugins/a2a-bridge/src/scheduler.ts` — 跨上下文有界并发与上下文内 FIFO。
- `business-agent/plugins/a2a-bridge/src/run-tracker.ts` — 请求到 turn 的关联和 assistant 文本流。
- `business-agent/plugins/a2a-bridge/src/executor.ts` — 由 Session 控制支持的 SDK `AgentExecutor`。
- `business-agent/plugins/a2a-bridge/src/request-handler.ts` — 操作白名单及执行中/持久化去重。
- `business-agent/plugins/a2a-bridge/src/server.ts` — 私有 Express 应用、Bearer 中间件、SDK 处理器与路由桥接。
- `business-agent/plugins/a2a-bridge/src/client.ts` — 官方 SDK 客户端创建与结果聚合。
- `business-agent/plugins/a2a-bridge/src/tool.ts` — 模型可见的 `call_a2a_agent` 定义。
- `business-agent/plugins/a2a-bridge/src/index.ts` — 只负责 Cordis 生命周期组合。

创建聚焦测试和文档：

- `business-agent/plugins/a2a-bridge/test/config-card.test.mjs`
- `business-agent/plugins/a2a-bridge/test/store.test.mjs`
- `business-agent/plugins/a2a-bridge/test/conversion-safe-fetch.test.mjs`
- `business-agent/plugins/a2a-bridge/test/scheduler-run-tracker.test.mjs`
- `business-agent/plugins/a2a-bridge/test/execution.test.mjs`
- `business-agent/plugins/a2a-bridge/test/request-handler.test.mjs`
- `business-agent/plugins/a2a-bridge/test/server.test.mjs`
- `business-agent/plugins/a2a-bridge/test/client-tool.test.mjs`
- `business-agent/plugins/a2a-bridge/README.md`、`README.zh.md` 和 `README.i18n.yaml`

修改集成表面：

- `pnpm-lock.yaml` — 解析后的精确 A2A 与 Express 依赖图。
- `business-agent/bundle/package.json` — 依赖桥接包。
- `business-agent/bundle/cordis.patch.yml` — 启用一个回环 A2A 实例。
- `business-agent/bundle/test/config.mjs` — 固定完整插件顺序和配置。
- `business-agent/bundle/README.md`、`README.zh.md` 和 `README.i18n.yaml` — 部署和仅 URL 用法。
- `business-agent/tests/package.json` — 纳入新的垂直切片。
- `business-agent/tests/a2a-vertical-slice.test.mjs` — 真实 Loader 组合，只脚本化 LLM。
- `business-agent/tests/fixtures/snapshot-a2a-call.ts` — 确定性的双智能体工具调用夹具。
- `snapshots/session/business-a2a-call/*` — 录制工具 schema、调用、结果、提示词和 Session 日志。
- `business-agent/README.md`、`README.zh.md` 和 `README.i18n.yaml` — 顶层快速开始。
- `.agents/notes/proposed/feature/2026-09-20-a2a-bridge.md`、`.zh.md` 和 `.i18n.yaml` — 编码前创建 proposed note；任务 9 将完成记录移到 `implemented/feature/`。

## 任务 1：搭建包、配置、Agent Card 和 Proposed Note

**文件：** 创建以上包元数据、`src/types.ts`、`src/config.ts`、`src/card.ts`、`test/config-card.test.mjs`、插件 README 三件套和 proposed Agent Note 三件套；修改 `pnpm-lock.yaml`。

**接口：**

```ts ignore-check
export type A2AContextId = Brand<string, 'A2AContextId'>
export type A2ATaskId = Brand<string, 'A2ATaskId'>
export type A2AMessageId = Brand<string, 'A2AMessageId'>

export interface ResolvedA2AConfig {
  readonly route: string
  readonly cardPath: '/.well-known/agent-card.json'
  readonly publicBaseUrl: URL
  readonly bearerToken?: string
  readonly requestTimeoutMs: number
  readonly outboundTimeoutMs: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly maxConcurrentContexts: number
  readonly agentPreset?: string
  readonly agentCard: AgentCard
}

export function resolveConfig(config: Config, deployment: { host: string; port: number; env: NodeJS.ProcessEnv }): ResolvedA2AConfig
export function buildAgentCard(config: ResolvedA2AConfig): AgentCard
```

- [ ] 添加 `package.json`、Host `tsconfig.json` 和 `tsdown.config.ts`。将 `@a2a-js/sdk` 精确固定为 `1.2.0`、`express` 为 `5.2.1`、`@types/express` 为 `5.0.6`；Cordis、Session Controller、Session、storage-domain、tools、webserver、brand、Schemastery 与 Zod 使用 workspace 依赖。
- [ ] 编写测试，拒绝非 HTTP 公共 URL、凭证、`publicBaseUrl` 中的 query/fragment、非绝对 route、空 skills、越界限制、`0.0.0.0` 缺少 token，以及引用到空 token。断言回环默认值、Card URL、模式、能力和 Bearer 声明。
- [ ] 运行 `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test`；预期因包和导出不存在而失败。
- [ ] 实现类型化配置与 Card builder。未配置时，用 `127.0.0.1` 和实际监听端口解析 `publicBaseUrl`；`0.0.0.0` 必须显式配置；从指定环境变量只读取一次 token。
- [ ] 添加精炼的中英文插件 README，以及包含 `Problem`、`Proposal`、`Alternatives considered`、`Acceptance criteria` 和 `Risks` 的 proposed feature Agent Note；文本完成后生成配对哈希。
- [ ] 运行聚焦包测试、`pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build`、`pnpm verify-agent-note-format` 和 `pnpm verify-translation-pairing`；预期全部通过。
- [ ] 提交：`git add business-agent/plugins/a2a-bridge .agents/notes/proposed/feature/2026-09-20-a2a-bridge.* pnpm-lock.yaml && git commit -m "feat(business-agent): scaffold A2A bridge"`。

## 任务 2：加入持久上下文与任务存储

**文件：** 创建 `src/store.ts` 和 `test/store.test.mjs`；扩展 `src/types.ts`。

**接口：**

```ts ignore-check
export interface A2ARepository {
  getContext(contextId: A2AContextId): Promise<A2AContextRecord | undefined>
  createContext(record: A2AContextRecord): Promise<void>
  getTask(taskId: A2ATaskId): Promise<Task | undefined>
  getTaskByMessageId(messageId: A2AMessageId): Promise<Task | undefined>
  saveTask(task: Task, inputMessageId?: A2AMessageId): Promise<void>
  markInterruptedTasksFailed(now: string): Promise<number>
  close(): Promise<void>
}

export class DomainTaskStore implements TaskStore {
  save(task: Task, context?: ServerCallContext): Promise<void>
  load(taskId: string, context?: ServerCallContext): Promise<Task | undefined>
  list(params: ListTasksRequest, context?: ServerCallContext): Promise<ListTasksResult>
}
```

- [ ] 定义版本 1 的 `a2a_bridge` 域，包含 `contexts` 与 `tasks` 表。使用 `Task.toJSON` 存储 protobuf Task，并通过 `Task.fromJSON` 校验和还原；存储域没有二级索引，因此在仓库互斥锁保护下通过明确扫描索引 `inputMessageId`。
- [ ] 编写上下文唯一性、未知项查询、Task 往返、message-id 查询、合法状态推进、拒绝改写终态和保留最终 Artifact 的测试。
- [ ] 加入审查重点第 4 项，使用一个打开两次的临时存储根。
- [ ] 运行 `node --test business-agent/plugins/a2a-bridge/test/store.test.mjs`；预期缺少仓库导出。
- [ ] 实现仓库写入，确保上下文/Task 关系在接纳前持久化。由于公共任务列表不在范围内，`list()` 抛出 SDK 的 unsupported-operation 错误。
- [ ] 运行聚焦测试和包构建；预期通过。
- [ ] 提交：`git add business-agent/plugins/a2a-bridge/src/types.ts business-agent/plugins/a2a-bridge/src/store.ts business-agent/plugins/a2a-bridge/test/store.test.mjs && git commit -m "feat(business-agent): persist A2A contexts and tasks"`。

## 任务 3：实现 Part 转换和有界 Fetch

**文件：** 创建 `src/conversion.ts`、`src/safe-fetch.ts` 和 `test/conversion-safe-fetch.test.mjs`。

**接口：**

```ts
interface Message {}
type UserContent = unknown
interface Artifact {}

export declare function a2aMessageToPrompt(message: Message): { content: UserContent; requestedMode: 'text' | 'json' }
export declare function assistantTextToArtifact(text: string, mode: 'text' | 'json'): Artifact
export declare function createBoundedFetch(policy: FetchPolicy): typeof fetch

export interface FetchPolicy {
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly maxRedirects: number
  readonly signal?: AbortSignal
}
```

- [ ] 编写转换测试，覆盖有序 Text Part、序列化为带标签不可信数据的 Data Part、不支持的 Part、空消息、严格单对象 JSON 输出、数组/标量/尾随文本和安全错误码。
- [ ] 编写本地服务器 fetch 测试，覆盖内嵌凭证、fragment、非 HTTP 协议、重定向循环、通过合成 fetch 检测 HTTPS 降级、超时、调用方 abort、精确字节上限、超大分块响应、无效 JSON，以及允许内网 `127.0.0.1`。
- [ ] 加入审查重点第 5 项，并断言所有接纳前失败都让注入的 Session prompt spy 保持为零。
- [ ] 运行 `node --test business-agent/plugins/a2a-bridge/test/conversion-safe-fetch.test.mjs`；预期缺少导出。
- [ ] 实现转换，不把远端数据插入系统指令。使用 `redirect: 'manual'` 手动处理重定向，合并超时与调用方 abort signal，取消超大响应体，并从错误中删去 URL 凭证。
- [ ] 运行聚焦测试和包构建；预期通过。
- [ ] 提交：`git add business-agent/plugins/a2a-bridge/src/conversion.ts business-agent/plugins/a2a-bridge/src/safe-fetch.ts business-agent/plugins/a2a-bridge/test/conversion-safe-fetch.test.mjs && git commit -m "feat(business-agent): validate A2A content and remote fetches"`。

## 任务 4：构建按上下文调度器与 Session Turn 跟踪器

**文件：** 创建 `src/scheduler.ts`、`src/run-tracker.ts` 和 `test/scheduler-run-tracker.test.mjs`；扩展 `src/types.ts`。

**接口：**

```ts ignore-check
export interface ContextScheduler {
  run<T>(taskId: A2ATaskId, contextId: A2AContextId, operation: (signal: AbortSignal) => Promise<T>): Promise<T>
  cancel(taskId: A2ATaskId): 'queued' | 'active' | 'missing'
  close(): Promise<void>
}

export interface SessionTurnTracker {
  track(input: {
    sessionId: SessionId
    requestId: SessionRequestId
    signal: AbortSignal
    onTextDelta(delta: string): void
  }): Promise<{ turn: number; text: string; reason: TurnEndReason }>
  close(): Promise<void>
}
```

- [ ] 编写调度器测试，证明同一上下文 FIFO、不同上下文按配置并发、移除排队任务、终止活动任务、关闭后拒绝接纳，以及 close 等待活动操作。
- [ ] 使用交错 Session 和 turn 编写跟踪器测试。用 `user/message.data.source.rpcId` 关联请求并取得所属 turn；只转发匹配的 `agent/assistant-stream` attempt，收集持久 `assistant/message` 文本块，直到该 turn 的 `turn/end`。
- [ ] 运行 `node --test business-agent/plugins/a2a-bridge/test/scheduler-run-tracker.test.mjs`；预期缺少调度器/跟踪器导出。
- [ ] 实现一个 Cordis `session/event` 监听器和一个 `agent/assistant-stream` 监听器，使用按 Session/request 建键的映射，并在结束或 abort 时确定性清理。不得使用进程级 Agent idle 状态。
- [ ] 运行聚焦测试和包构建；预期通过。
- [ ] 提交：`git add business-agent/plugins/a2a-bridge/src/types.ts business-agent/plugins/a2a-bridge/src/scheduler.ts business-agent/plugins/a2a-bridge/src/run-tracker.ts business-agent/plugins/a2a-bridge/test/scheduler-run-tracker.test.mjs && git commit -m "feat(business-agent): correlate A2A tasks with session turns"`。

## 任务 5：实现入站执行、状态转换和取消

**文件：** 创建 `src/executor.ts` 和 `test/execution.test.mjs`；修改 `src/store.ts`、`src/conversion.ts` 和 `src/types.ts`。

**接口：**

```ts
interface AgentExecutor {}
interface RequestContext {}
interface ExecutionEventBus {}

export declare class DshAgentExecutor implements AgentExecutor {
  execute(request: RequestContext, events: ExecutionEventBus): Promise<void>
  cancelTask(taskId: string, events: ExecutionEventBus): Promise<void>
}
```

- [ ] 编写测试，要求首个发布事件为 submitted Task，之后依次为 `working`、Artifact update 和且仅一个终态。覆盖新上下文/Session 创建、已知上下文延续、未知上下文、Session 创建/prompt 失败、超时、文本输出和请求 JSON 输出。
- [ ] 加入审查重点第 3 项：在明确屏障处暂停排队和活动操作，让取消与完成竞态，并断言只有所属 Session 的活动 turn 收到 `sessionController.cancel({ sessionId })`。
- [ ] 运行 `node --test business-agent/plugins/a2a-bridge/test/execution.test.mjs`；预期缺少 executor 导出。
- [ ] 使用 `crypto.randomUUID()` 实现 Task id 和 context id。在 `sessionController.prompt({ mode: 'queue' })` 前持久化上下文和 submitted Task；在 prompt 接纳前注册 tracker；先发最终 Artifact，再发终态；映射不含 prompt 或凭证文本的稳定失败。
- [ ] 超时时 abort tracker、取消活动 Session、等待调度器收敛，再写入 `failed`。取消排队任务时写 `canceled`，不取消 Session。对已终止任务原样返回。
- [ ] 运行聚焦测试和包构建；预期通过。
- [ ] 提交：`git add business-agent/plugins/a2a-bridge/src/types.ts business-agent/plugins/a2a-bridge/src/store.ts business-agent/plugins/a2a-bridge/src/conversion.ts business-agent/plugins/a2a-bridge/src/executor.ts business-agent/plugins/a2a-bridge/test/execution.test.mjs && git commit -m "feat(business-agent): execute A2A tasks through sessions"`。

## 任务 6：加入操作白名单和重复抑制

**文件：** 创建 `src/request-handler.ts` 和 `test/request-handler.test.mjs`；修改 `src/store.ts`。

**接口：**

```ts ignore-check
export class BridgeRequestHandler extends DefaultRequestHandler {
  sendMessage(params: SendMessageRequest, context?: ServerCallContext): Promise<SendMessageResult>
  sendMessageStream(params: SendMessageRequest, context?: ServerCallContext): AsyncGenerator<StreamResponse>
  listTasks(): Promise<never>
  subscribeToTask(): Promise<never>
}
```

- [ ] 编写测试，只允许同步发送、流式发送、查询和取消；断言列表、重新订阅、push 配置和扩展 Card 请求返回 SDK 标准 unsupported-operation 失败。
- [ ] 加入审查重点第 1 项，设置首次请求屏障，并同时进行同步/流式重复重试。断言一个持久 Task、一次 prompt、相同 Task id，并且持久 Task 已终止后不重放部分流。
- [ ] 运行 `node --test business-agent/plugins/a2a-bridge/test/request-handler.test.mjs`；预期缺少 handler 导出。
- [ ] 在委托给 `DefaultRequestHandler` 前，实现按 message-id 的 single-flight map；创建 flight 前查询持久仓库。执行中的重复请求等待其 Task 并返回/发布该 Task；已结束的重复请求立即返回。
- [ ] 使用 `new DefaultRequestHandler(agentCard, taskStore, executor)` 构造父类，只覆盖白名单和去重需要的行为。
- [ ] 运行聚焦测试和包构建；预期通过。
- [ ] 提交：`git add business-agent/plugins/a2a-bridge/src/store.ts business-agent/plugins/a2a-bridge/src/request-handler.ts business-agent/plugins/a2a-bridge/test/request-handler.test.mjs && git commit -m "feat(business-agent): deduplicate A2A requests"`。

## 任务 7：将 SDK 服务器挂到共享 Web Listener

**文件：** 创建 `src/server.ts` 和 `test/server.test.mjs`；修改 `src/index.ts` 和 `test/config-card.test.mjs`。

**接口：**

```ts ignore-check
export interface A2AServer {
  readonly cardUrl: URL
  readonly rpcUrl: URL
  close(): Promise<void>
}

export function createA2AServer(ctx: Context, config: ResolvedA2AConfig, handler: RequestHandler): A2AServer
```

- [ ] 使用官方客户端编写集成测试，覆盖公开 Card 发现、同步发送、SSE 流顺序、查询、取消、方法/媒体类型拒绝、JSON body 上限、带 `WWW-Authenticate` 的 401，以及时间安全的精确 Bearer 接受。
- [ ] 加入审查重点第 2 项：在 `working` 后断开 SSE，完成脚本化 Agent turn，并确认 `GetTask` 返回完成的 Artifact。
- [ ] 运行 `node --test business-agent/plugins/a2a-bridge/test/server.test.mjs`；预期缺少 server/entry 导出。
- [ ] 创建私有 `express()` 应用，使用 `@a2a-js/sdk/server/express` 的 `agentCardHandler` 和 `jsonRpcHandler`。通过 `ctx.webServer.register` 注册精确 Card 与 RPC 路由；适配现有 request/response，不打开第二个 listener。
- [ ] 仅在 RPC 路由应用认证，使用 `express.json({ limit: maxRequestBytes })`，通过 `timingSafeEqual` 比较等长 token buffer，并安装不会回显 body 的安全 HTTP 错误中间件。
- [ ] 在 `src/index.ts` 组合仓库恢复、调度器、tracker、executor、handler、server 和后续工具注册。按逆依赖顺序注册 Cordis cleanup，并等待活动执行、流、路由和存储全部关闭。
- [ ] 运行聚焦测试和包构建；预期通过。
- [ ] 提交：`git add business-agent/plugins/a2a-bridge/src/server.ts business-agent/plugins/a2a-bridge/src/index.ts business-agent/plugins/a2a-bridge/test/server.test.mjs business-agent/plugins/a2a-bridge/test/config-card.test.mjs && git commit -m "feat(business-agent): expose A2A protocol routes"`。

## 任务 8：加入出站客户端和 `call_a2a_agent` 工具

**文件：** 创建 `src/client.ts`、`src/tool.ts` 和 `test/client-tool.test.mjs`；修改 `src/index.ts` 和插件 README 三件套。

**接口：**

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface CallA2AAgentInput {
  readonly agent_card_url: string
  readonly message: string | JsonValue
  readonly context_id?: string
  readonly stream?: boolean
  readonly accepted_output_mode?: 'text' | 'json'
  readonly timeout_ms?: number
}

export interface CallA2AAgentResult {
  readonly context_id?: string
  readonly task_id?: string
  readonly state: string
  readonly output?: string | JsonValue
  readonly failure?: { readonly code: string; readonly message: string }
}
```

- [ ] 在测试中于 `127.0.0.1:0` 启动临时官方 SDK 服务器。覆盖同步、流聚合、按返回 context id 继续、JSON 输入/输出、远端失败、超时、带有界 `CancelTask` 的调用方取消、响应大小拒绝，以及每次调用都重新获取 Card。
- [ ] 断言工具 schema 恰好有六个已批准输入且没有 Authorization 字段；断言 `presentCall`、`presentResult` 和渲染输出暴露 id/state/output，但不暴露远端 stack 或完整响应体。
- [ ] 运行 `node --test business-agent/plugins/a2a-bridge/test/client-tool.test.mjs`；预期缺少 client/tool 导出。
- [ ] 使用 `DefaultAgentCardResolver({ fetchImpl })` 和 `JsonRpcTransportFactory({ fetchImpl })` 构建 `ClientFactory`；调用 `createFromUrl(cardUrl.href, '')`。流式调用聚合 `payload.$case` 的 `message`、`task`、`statusUpdate` 和 `artifactUpdate`，直到终态。
- [ ] 通过 `ctx.tools.register(defineTool(...))` 定义并注册 `call_a2a_agent`。将 `timeout_ms` 限制在配置最大值内；本地取消发生且已知 Task id 时，只尝试一次有界远端取消，然后在本地结束。
- [ ] 在两种语言 README 中记录精确的仅 URL 调用方式和首版无出站认证限制；更新配对哈希。
- [ ] 运行聚焦测试、包构建和翻译配对校验；预期通过。
- [ ] 提交：`git add business-agent/plugins/a2a-bridge && git commit -m "feat(business-agent): add outbound A2A tool"`。

## 任务 9：接入 Bundle、证明垂直切片并完成文档

**文件：** 修改文件地图中的全部 bundle/test/doc 文件，并创建夹具、快照树和 implemented Agent Note 文件。

**接口：** Bundle 条目必须使用 `id: business-a2a-bridge`、包名 `@deepseek-ai/dsh-business-a2a-bridge`、路由 `/a2a` 和回环 `publicBaseUrl: http://127.0.0.1:3081`。检入的默认配置省略 `bearerTokenEnv`，使两个本地实例能仅凭 URL 互调；生产内网文档必须展示 token 环境配置。

- [ ] 先扩展 `business-agent/bundle/test/config.mjs`，让它期望 bridge 位于现有业务插件之后并固定完整默认配置；运行 `pnpm --filter @deepseek-ai/dsh-business-agent test`，观察预期的配置失败。
- [ ] 添加 bundle 依赖和 Cordis 条目，重新运行 bundle 构建/测试并预期通过。
- [ ] 编写 `a2a-vertical-slice.test.mjs`：启动真实 Loader profile，通过官方客户端发现 Card，在同一上下文发送两次、另一上下文发送一次、流式处理一次、查询一个 Task、取消一个被屏障暂停的 Task，再用相同存储根重启并验证上下文复用。夹具绑定 `127.0.0.1:0`；使用明确屏障和唯一 id，不使用 sleep 或进程全局变更。
- [ ] 运行 `node --test business-agent/tests/a2a-vertical-slice.test.mjs`；夹具/组合未完成前预期失败，然后只补齐断言所需的 Loader 与脚本化 LLM plumbing，再运行至通过。
- [ ] 添加确定性的 `business-a2a-call` 录制 Session 用例。通过 `dsh` profile 录制，不新增可执行入口；验证快照拥有 `call_a2a_agent` schema、调用/结果、prompt 和持久 Session 事件，且不含凭证或推理。
- [ ] 更新 bundle 与 Business Agent 顶层 README 双语对，记录启动方式、Card/RPC URL、token 规则、双实例仅 URL 示例、支持操作、限制和非目标。每段使用一个物理行，并刷新 sidecar 哈希。
- [ ] 将 proposed Agent Note 移至 `.agents/notes/implemented/feature/`，把 `Proposal` 改写为 `Decision`、`Acceptance criteria` 改写为 `Consequences`，保留 `Problem` 和 `Alternatives considered`；更新翻译 sidecar。
- [ ] 运行聚焦验证：`pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test`、对应 build、bundle build/test，以及 `pnpm --filter @deepseek-ai/dsh-business-agent-tests test`。
- [ ] 按 `dsh-pre-push-checks` 选择并运行快照与仓库验证：`business-a2a-call` 录制 Session replay、`pnpm typecheck`、`pnpm lint`、`pnpm verify-agent-note-format`、`pnpm verify-agent-note-classification`、`pnpm verify-translation-pairing`、`pnpm verify-md-links` 和 `pnpm constraints`。在交接中记录每条命令与退出码。
- [ ] 检查 `git diff --check`、`git status --short` 和完整分支 diff；确认没有 `packages/` 或 `apps/` 变更、没有凭证、没有生成的构建输出。
- [ ] 提交：`git add business-agent snapshots/session/business-a2a-call .agents/notes/implemented/feature/2026-09-20-a2a-bridge.* pnpm-lock.yaml && git commit -m "feat(business-agent): ship A2A bridge"`。

## 完成门槛

只有满足以下条件才算完成：官方 A2A v1.0 客户端针对真实 Business Agent 组合通过发现、同步、流式、查询和取消；第二个本地 Business Agent 仅凭 Agent Card URL 与消息被成功调用；重启恢复与五项审查重点测试全部通过；聚焦构建、类型、lint、文档、Agent Note、快照 replay 与约束检查全部通过；最终分支 diff 仅位于 `business-agent/`、`snapshots/session/business-a2a-call/`、`.agents/notes/` 和 `pnpm-lock.yaml`。
