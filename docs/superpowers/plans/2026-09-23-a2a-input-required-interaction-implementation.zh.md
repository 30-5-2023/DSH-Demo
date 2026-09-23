# A2A v0.3 Input-Required 交互实现计划

[English](2026-09-23-a2a-input-required-interaction-implementation.md) | 中文

> **供智能体执行者使用：** 必须使用子技能：用 superpowers:executing-plans 逐任务实现本计划。

**目标：** 让入站 A2A v0.3 Task 在 `ask_user_question` 时暂停，公开持久化的 `input-required` Message，通过同一 Task 的回答恢复同一个 DSH 轮次，并让 `call_a2a_agent` 返回或续答远端交互。

**架构：** 新增一个仅属于插件的交互编解码器和代理器。代理器把准确的在线 DSH Session 与其 A2A 执行关联，在内存中暂停现有 `ask_user_question` Promise，并要求执行器持久化每次状态转换。同一 Task 的 A2A Message 被路由至该代理器，而不是启动另一个 Session 轮次。出站客户端把 `input-required` 作为已收敛调用结果，并复用现有 Part 和文件物化路径。

**技术栈：** TypeScript、Cordis waterfall 事件、与 A2A v0.3 线缆兼容的 `@a2a-js/sdk` 1.2.0、精确 Python `a2a-sdk==0.3.2`、Node 测试运行器、DSH Session 快照。

**规格：** [A2A v0.3 Input-Required 交互设计](../specs/2026-09-23-a2a-input-required-interaction-design.zh.md)

## 全局约束

- 所有产品改动都保留在 `business-agent/`；不修改 `packages/` 或 `apps/`。
- 只实现已批准的 A2A v0.3 行为。将 v1 保留为回归表面，而不是第二套交互协议。
- 只把 `ryubyte/dsh-a2a` 作为设计参考；不导入或 vendoring 它。
- 只使用标准 A2A `Message`、`TextPart`、`DataPart`、`FilePart`、Task 状态、Task 历史以及同一 Task 的 `message/send`；不增加私有端点。
- Task 处于 `input-required` 时，在内存中保持原 DSH 模型轮次和 `ask_user_question` Promise 等待。
- 把每个模型可见问题、回答、校验失败、状态转换和最终结果存入持久化 Task 记录。
- 继续接受仅 URL 的内网部署；本次变更不增加鉴权。
- 测试使用 deferred barrier 和注入式 deadline。不使用 sleep、固定端口、进程全局变更，清理后不得残留监听器、子进程或 Promise。
- 每个实现切片先写失败测试，观察指定失败，添加最少代码，观察通过，然后提交该切片。

## 审查重点

批准实现前审查以下五类故障。下列任务为每一类都增加显式测试。

1. 已识别但无效的响应 `DataPart` 与看似有效的文本并存时必须保持 `input-required`；否则结构化调用方可能意外绕过校验。
2. 续答可能在原请求排空期间、事件流返回后或与另一个回答并发到达；必须只有一个有效回答恢复且只恢复一个模型轮次。
3. 工具等待期间取消、超时、关闭或重启时，必须只拒绝一次暂停的 Promise，并且只释放一次调度器槽位、上下文锁、事件总线和 Session 操作。
4. `tasks/get`、阻塞发送和流式发送必须公开同一个状态 Message；`historyLength` 可以裁剪历史，但不能移除 `status.message`。
5. 远端状态 Message 中的文本、数据和文件 Part 必须在同步和流式出站调用中保留，精确 Python `a2a-sdk==0.3.2` 必须完成相同的暂停、查询和恢复流程。

---

### 任务 1：增加带版本的问题和回答编解码器

**文件：**

- 修改：`business-agent/plugins/a2a-bridge/package.json`
- 修改：`business-agent/plugins/a2a-bridge/src/types.ts`
- 新建：`business-agent/plugins/a2a-bridge/src/interaction.ts`
- 新建：`business-agent/plugins/a2a-bridge/test/interaction.test.mjs`
- 修改：`pnpm-lock.yaml`

**接口：**

```ts
export const A2A_INPUT_REQUIRED_SCHEMA = 'urn:deepseek-harness:a2a:input-required:v1'
export const A2A_INPUT_RESPONSE_SCHEMA = 'urn:deepseek-harness:a2a:input-response:v1'

export interface A2AInteractionError {
  readonly code: 'A2A_INTERACTION_INVALID_RESPONSE'
  readonly message: string
}

export type ParsedInteractionAnswer =
  | { readonly ok: true; readonly answer: AskUserQuestionAnswer }
  | { readonly ok: false; readonly error: A2AInteractionError }

export function createInputRequiredMessage(input: {
  readonly taskId: A2ATaskId
  readonly contextId: A2AContextId
  readonly questions: readonly AskUserQuestionItem[]
  readonly error?: A2AInteractionError
}): Message

export function parseInteractionAnswer(
  message: Message,
  questions: readonly AskUserQuestionItem[],
): ParsedInteractionAnswer
```

- [ ] **步骤 1：编写失败的编解码测试。** 覆盖 `id`、`question`、可选 `header`、`detail`、`options`、`multiSelect` 和 `intent` 的保留；可读 TextPart 生成；唯一 `messageId`；精确 schema URN；以及带校验错误的 DataPart。
- [ ] **步骤 2：增加回答测试。** 接受完整结构化覆盖和 TextPart 回退；拒绝缺少、重复或未知 id、不可用选项、非法多选、无选项却缺少 `custom` 的回答以及仅含 FilePart 的输入。断言已识别的无效 DataPart 不会回退至相邻文本，多问题纯文本只映射到第一个问题的 `custom`。
- [ ] **步骤 3：运行 `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/interaction.test.mjs`。** 确认因编解码器和用户问题类型不存在而失败。
- [ ] **步骤 4：把 `@deepseek-ai/dsh-user-questions` 增加为 peer 和 dev 依赖，定义 schema 常量及错误/结果类型，并在 A2A 线缆边界实现严格 JSON 收窄。** 编解码器保持纯函数；不得访问 Cordis、存储或进程状态。
- [ ] **步骤 5：重新运行聚焦构建和测试。** 确认每个 Part 和校验分支通过。
- [ ] **步骤 6：提交。**

```powershell
git add business-agent/plugins/a2a-bridge/package.json business-agent/plugins/a2a-bridge/src/types.ts business-agent/plugins/a2a-bridge/src/interaction.ts business-agent/plugins/a2a-bridge/test/interaction.test.mjs pnpm-lock.yaml
git commit -m "feat(business-agent): encode A2A input-required messages"
```

### 任务 2：把在线 DSH 问题桥接到一个暂停的 A2A 执行

**文件：**

- 修改：`business-agent/plugins/a2a-bridge/src/interaction.ts`
- 修改：`business-agent/plugins/a2a-bridge/src/index.ts`
- 修改：`business-agent/plugins/a2a-bridge/src/types.ts`
- 修改：`business-agent/plugins/a2a-bridge/test/interaction.test.mjs`
- 修改：`business-agent/plugins/a2a-bridge/test/plugin-lifecycle.test.mjs`

**接口：**

```ts
export interface A2AQuestionWindow extends Disposable {
  readonly taskId: A2ATaskId
  hasPendingQuestion(): boolean
  continue(message: Message): Promise<'accepted' | 'invalid' | 'duplicate'>
}

export interface A2AQuestionWindowOptions {
  readonly taskId: A2ATaskId
  readonly contextId: A2AContextId
  readonly sessionId: SessionId
  readonly signal: AbortSignal
  readonly publishInputRequired: (message: Message) => Promise<void>
  readonly publishWorking: () => Promise<void>
}

export class A2AQuestionBroker implements Disposable {
  open(options: A2AQuestionWindowOptions): A2AQuestionWindow
  answer(request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>
  find(taskId: A2ATaskId): A2AQuestionWindow | undefined
  [Symbol.dispose](): void
}
```

- [ ] **步骤 1：用 deferred barrier 编写失败的代理器测试。** 证明只拦截准确注册的 `request.agent.id`，无关请求调用 `next()`，每个 Task 只允许一个问题等待，`publishInputRequired` 完成后 Promise 才保持暂停，有效回答必须等 `publishWorking` 完成后才解析 Promise。
- [ ] **步骤 2：增加竞态测试。** 第一个有效回答胜出；相同回答 `messageId` 幂等；后续并发回答返回 `duplicate`；无效结构化输入重新发布带 `A2A_INTERACTION_INVALID_RESPONSE` 的 `input-required`；abort 和 dispose 只拒绝一次等待，并删除 Session 与 Task 两个索引。
- [ ] **步骤 3：运行聚焦测试。** 确认因代理器或用户问题监听器不存在而失败。
- [ ] **步骤 4：用每个窗口一个 pending deferred 对象和按 `SessionId`、`A2ATaskId` 建立的两个索引实现代理器。** 保持 `continue` 内的提交顺序：校验、等待 `publishWorking`、把 message id 标记为已消费，然后解析工具 Promise。无效输入通过 `publishInputRequired` 路由，不解析 Promise。
- [ ] **步骤 5：在 `src/index.ts` 注入 `userQuestions`，并将 `ctx.on('user-questions/request', ...)` 注册成 Cordis 所有的 effect。** 随插件运行时释放监听器和代理器；不修改共享用户问题包。
- [ ] **步骤 6：重新运行 `interaction.test.mjs` 和 `plugin-lifecycle.test.mjs`。** 确认拦截、委派和无计时器的静默清理通过。
- [ ] **步骤 7：提交。**

```powershell
git add business-agent/plugins/a2a-bridge/src/interaction.ts business-agent/plugins/a2a-bridge/src/index.ts business-agent/plugins/a2a-bridge/src/types.ts business-agent/plugins/a2a-bridge/test/interaction.test.mjs business-agent/plugins/a2a-bridge/test/plugin-lifecycle.test.mjs
git commit -m "feat(business-agent): suspend A2A turns for DSH questions"
```

### 任务 3：持久化 `input-required` 并恢复同一执行器轮次

**文件：**

- 修改：`business-agent/plugins/a2a-bridge/src/executor.ts`
- 修改：`business-agent/plugins/a2a-bridge/src/types.ts`
- 修改：`business-agent/plugins/a2a-bridge/test/execution.test.mjs`

**接口：**

```ts
interface ExecutionRecord {
  // Existing fields stay unchanged.
  interaction?: A2AQuestionWindow
}

export interface DshAgentExecutorOptions {
  // Existing ports stay unchanged.
  readonly interactions: A2AQuestionBroker
}
```

- [ ] **步骤 1：用准确 Session id 和代理器扩展执行器夹具。** 编写失败测试：启动 `execute`，发送有作用域的 `AskUserQuestionRequest`，等待持久化的 `input-required` 状态，并断言原 prompt 和 scheduler run 仍在等待。
- [ ] **步骤 2：增加失败的续答测试。** 用相同 `taskId` 和有效响应 Message 再次调用 `execute`。断言不创建新 Task、Session、调度器准入或 `sessionController.prompt`；断言 Task 在工具 Promise 解析前转为 `working`，然后原轮次正常完成。
- [ ] **步骤 3：增加历史与无效回答测试。** 每次转换前从仓库刷新 Task，从而保留 SDK 追加的回答 Message；追加每个智能体问题或校验 Message；无效结构化输入后 Task 保持 `input-required`。
- [ ] **步骤 4：增加并发测试。** 覆盖原请求排空前回答到达、两个不同有效回答同时释放、重试相同 `messageId`，以及 `working` 或终态后的迟到回答。断言只有一个 resolver、一个第二模型阶段和一次终态写入。
- [ ] **步骤 5：运行 `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/execution.test.mjs`。** 确认新测试失败，因为所有同一 Task 输入仍走新轮次准入。
- [ ] **步骤 6：在 `runTurn` 内用现有 deadline signal 打开问题窗口。** 其回调必须重载仓库 Task，追加智能体 Message，保存 `input-required` 或 `working`，更新 `record.task`，并在返回前发布相应状态事件。
- [ ] **步骤 7：在 `execute` 的新 Task 准入之前增加续答分支。** 把 `input-required` 路由到活动窗口；让观察到 `working` 的请求附着 `record.done`；若完成在竞态中胜出，则发布最新终态 Task。此分支绝不调用 `scheduler.run` 或 `sessionController.prompt`。
- [ ] **步骤 8：重新运行聚焦测试。** 确认全部状态、历史、顺序和首答胜出断言通过。
- [ ] **步骤 9：提交。**

```powershell
git add business-agent/plugins/a2a-bridge/src/executor.ts business-agent/plugins/a2a-bridge/src/types.ts business-agent/plugins/a2a-bridge/test/execution.test.mjs
git commit -m "feat(business-agent): resume A2A input-required tasks"
```

### 任务 4：补全查询、流式、取消、超时和重启行为

**文件：**

- 修改：`business-agent/plugins/a2a-bridge/src/executor.ts`
- 修改：`business-agent/plugins/a2a-bridge/src/request-handler.ts`
- 修改：`business-agent/plugins/a2a-bridge/src/store.ts`
- 修改：`business-agent/plugins/a2a-bridge/test/store.test.mjs`
- 修改：`business-agent/plugins/a2a-bridge/test/server.test.mjs`
- 修改：`business-agent/plugins/a2a-bridge/test/request-handler.test.mjs`
- 修改：`business-agent/plugins/a2a-bridge/test/execution.test.mjs`

- [ ] **步骤 1：增加阻塞与流式发送的失败服务器测试。** 原请求必须在 `input-required` 返回，事件总线必须保持可复用，`tasks/get` 必须返回相同 `status.message`，`historyLength: 0` 不得删除该状态 Message。
- [ ] **步骤 2：增加同一 Task 回答的失败请求处理器测试。** 验证处理器追加调用方回答 Message、推断省略的 `contextId`、拒绝不匹配的上下文，并且绝不接受未知或终态 Task 的续答。
- [ ] **步骤 3：用 barrier 和注入式受控 deadline 增加取消与时限测试。** 等待期间断言上下文锁和一个 `maxConcurrentContexts` 槽位仍被占用。等待期间取消并断言 `canceled`；触发现有请求 deadline 并断言以 `A2A_EXECUTION_TIMEOUT` 进入 `failed`；两种情况都断言一次 abort、一次 Session cancel、一次终态事件以及上下文/并发容量释放。
- [ ] **步骤 4：扩展重启测试。** 持久化 `input-required`，用同一存储根重新打开，运行 `markInterruptedTasksFailed`，断言以 `A2A_HOST_INTERRUPTED` 进入 `failed`，而 completed/canceled/failed Task 不变。
- [ ] **步骤 5：运行四个聚焦测试文件。** 确认在查询一致性、生命周期收敛或重启恢复处失败。
- [ ] **步骤 6：把 `input-required` 纳入中断 Task 恢复，并按测试要求对执行器/请求处理器做最小修正。** 重启后不重建或恢复内存中的工具 Promise。
- [ ] **步骤 7：重新运行四个聚焦测试文件。** 确认没有测试依赖真实时间 sleep 或固定端口，清理达到静默状态。
- [ ] **步骤 8：提交。**

```powershell
git add business-agent/plugins/a2a-bridge/src/store.ts business-agent/plugins/a2a-bridge/src/executor.ts business-agent/plugins/a2a-bridge/src/request-handler.ts business-agent/plugins/a2a-bridge/test/store.test.mjs business-agent/plugins/a2a-bridge/test/server.test.mjs business-agent/plugins/a2a-bridge/test/request-handler.test.mjs business-agent/plugins/a2a-bridge/test/execution.test.mjs
git commit -m "fix(business-agent): settle interrupted A2A waits"
```

### 任务 5：从 `call_a2a_agent` 返回和续答远端交互

**文件：**

- 修改：`business-agent/plugins/a2a-bridge/src/types.ts`
- 修改：`business-agent/plugins/a2a-bridge/src/client.ts`
- 修改：`business-agent/plugins/a2a-bridge/src/tool.ts`
- 修改：`business-agent/plugins/a2a-bridge/test/client-tool.test.mjs`

**接口：**

```ts
export interface CallA2AAgentInput {
  // Existing fields stay unchanged.
  readonly task_id?: string
}

export interface A2AInteractionResult {
  readonly text?: string
  readonly data?: readonly JsonValue[]
}

export interface CallA2AAgentResult {
  // Existing fields stay unchanged.
  readonly interaction?: A2AInteractionResult
}
```

- [ ] **步骤 1：增加失败的同步和流式客户端测试。** 远端 `input-required` Task 必须立即收敛，返回 `task_id`、可读交互文本、每个 DataPart 值，并把 FilePart 物化到现有 `files` 数组。最终 Artifact 必须保留在 `output`/`files`，与 `interaction` 分离。
- [ ] **步骤 2：增加失败的续答测试。** 传入 `task_id` 时必须把该 id 放入 SDK 请求；字符串 `message` 必须变成 TextPart，JSON `message` 必须变成 DataPart；恢复后的最终结果必须复用同一 Task id。
- [ ] **步骤 3：增加聚合竞态测试。** 从 Task 响应和 status-update 事件捕获 `status.message`，包括以 `input-required` 结束的流；不等待终态。把 `auth-required` 状态保留为不会挂起的中断结果，但不声称支持 v1 交互。
- [ ] **步骤 4：运行聚焦构建和 `client-tool.test.mjs`。** 确认客户端当前挂起或遗漏状态 Message，并且工具 schema 拒绝 `task_id`/`interaction`。
- [ ] **步骤 5：把 `task_id` 增加到工具输入 schema，把 `interaction` 增加到输出 schema 和安全展示。** 扩展请求创建、收敛状态检测、流聚合和状态 Message Part 转换。复用现有文件发布/物化及大小策略；不把大文件内联进交互 JSON。
- [ ] **步骤 6：重新运行聚焦测试。** 确认同步、流式、结构化输入、纯文本和状态 FilePart 用例通过。
- [ ] **步骤 7：提交。**

```powershell
git add business-agent/plugins/a2a-bridge/src/types.ts business-agent/plugins/a2a-bridge/src/client.ts business-agent/plugins/a2a-bridge/src/tool.ts business-agent/plugins/a2a-bridge/test/client-tool.test.mjs
git commit -m "feat(business-agent): continue remote A2A interactions"
```

### 任务 6：通过真实 Loader 和 Python 0.3.2 证明完整流程

**文件：**

- 修改：`business-agent/tests/fixtures/a2a-scripted-llm.ts`
- 修改：`business-agent/tests/a2a-vertical-slice.test.mjs`
- 修改：`business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs`
- 修改：`business-agent/tests/fixtures/a2a-python-v032-peer.py`

- [ ] **步骤 1：用 `ask_user_question` 场景扩展脚本 LLM。** 第一阶段发出包含两个问题和选项的工具调用；工具结果记录后，第二阶段发出包含所选值的确定性最终回答。
- [ ] **步骤 2：增加失败的真实 Loader 垂直切片。** 在端口 `0` 启动 bundle，通过官方 A2A 客户端发送，断言 `input-required`，通过 `tasks/get` 获取它，在同一 Task 发送结构化响应，并断言完成、一个持久化 DSH Session、保留 Task 历史，以及 Loader 释放后无残留监听器。
- [ ] **步骤 3：双向扩展精确版本 Python peer。** Python 客户端必须解析 JavaScript 问题的 TextPart/DataPart、查询 Task、回答并观察完成。Python 服务端必须发出 `input-required`；JavaScript 客户端必须返回 `interaction`，用 `task_id` 回答并观察最终文本。包含一个状态 FilePart，让 JavaScript 端证明现有本地文件物化。
- [ ] **步骤 4：保持子进程确定性。** 从自有监听器分配端口，用 ready 行替代 sleep，限制每个协议步骤，关闭 stdin/监听器，只终止自有子进程，等待退出，并在失败时保留 stdout/stderr。
- [ ] **步骤 5：运行 `pnpm --filter @deepseek-ai/dsh-business-tests test` 和精确版本验证器。** 确认新场景在实现完整前失败，然后用 `a2a-sdk==0.3.2` 通过。

```powershell
pnpm run verify:a2a-python-v032
pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build
node --test business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs
```

- [ ] **步骤 6：提交。**

```powershell
git add business-agent/tests/fixtures/a2a-scripted-llm.ts business-agent/tests/a2a-vertical-slice.test.mjs business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs business-agent/tests/fixtures/a2a-python-v032-peer.py
git commit -m "test(business-agent): cover A2A question continuations"
```

### 任务 7：更新快照、运维文档和 A2A Agent Note

**文件：**

- 修改：`snapshots/session/business-a2a-call/tool-schemas.expected.json`
- 修改：`snapshots/session/business-a2a-call/session.v3.jsonl`
- 修改：`snapshots/session/business-a2a-call/snapshot.yml`
- 修改：`business-agent/tests/fixtures/snapshot-a2a-call.ts`
- 修改：`business-agent/plugins/a2a-bridge/README.md`
- 修改：`business-agent/plugins/a2a-bridge/README.zh.md`
- 修改：`business-agent/plugins/a2a-bridge/README.i18n.yaml`
- 修改：`business-agent/README.md`
- 修改：`business-agent/README.zh.md`
- 修改：`business-agent/README.i18n.yaml`
- 修改：`business-agent/migration/README.md`
- 修改：`business-agent/migration/README.zh.md`
- 修改：`business-agent/migration/README.i18n.yaml`
- 修改：`.agents/notes/implemented/feature/2026-09-20-a2a-bridge.md`
- 修改：`.agents/notes/implemented/feature/2026-09-20-a2a-bridge.zh.md`
- 修改：`.agents/notes/implemented/feature/2026-09-20-a2a-bridge.i18n.yaml`

- [ ] **步骤 1：更新录制场景和预期 schema。** 在工具输入记录 `task_id`，在工具输出记录 `interaction`，并记录一次确定性的 `input-required` 结果及后续同一 Task 完成，从而让模型可见行为可由 Session 日志重建。
- [ ] **步骤 2：运行 `pnpm run test:snapshot -t business-a2a-call`。** 检查语义 diff；不要手工归一化由快照夹具负责的 id 或时间戳。
- [ ] **步骤 3：逐行更新英文和中文插件及部署文档。** 记录两个 schema URN、结构化与纯文本回答、`tasks/get` 以及不存在 `message/get`、出站续答、本地文件行为、默认五分钟超时、重启失败、并发容量占用，以及精确 Python 0.3.2 验证命令。说明 FilePart 随交互返回，但不能回答 `ask_user_question`。
- [ ] **步骤 4：扩展现有 A2A Agent Note，而不是创建竞争的决策记录。** 记录选定的内存暂停加持久化 Task 状态设计、被拒绝的替代方案、失败语义和验证证据。使用当前状态叙述，避免审查过程叙述。
- [ ] **步骤 5：重录全部四个翻译配对 sidecar 并运行文档检查。**

```powershell
pnpm run verify-translation-pairing --write business-agent/plugins/a2a-bridge/README.md
pnpm run verify-translation-pairing --write business-agent/README.md
pnpm run verify-translation-pairing --write business-agent/migration/README.md
pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-09-20-a2a-bridge.md
pnpm run test:docs
pnpm run doc-sync
```

- [ ] **步骤 6：提交。**

```powershell
git add snapshots/session/business-a2a-call business-agent/tests/fixtures/snapshot-a2a-call.ts business-agent/plugins/a2a-bridge/README.md business-agent/plugins/a2a-bridge/README.zh.md business-agent/plugins/a2a-bridge/README.i18n.yaml business-agent/README.md business-agent/README.zh.md business-agent/README.i18n.yaml business-agent/migration/README.md business-agent/migration/README.zh.md business-agent/migration/README.i18n.yaml .agents/notes/implemented/feature/2026-09-20-a2a-bridge.md .agents/notes/implemented/feature/2026-09-20-a2a-bridge.zh.md .agents/notes/implemented/feature/2026-09-20-a2a-bridge.i18n.yaml
git commit -m "docs(business-agent): document A2A input-required flow"
```

### 任务 8：运行聚焦门禁、审查 diff 并准备分支

**文件：**

- 审查：任务 1-7 改动的每个文件

- [ ] **步骤 1：调用 `dsh-pre-push-checks`，并按实际出站 diff 选择检查。** 至少保留下列聚焦包、bundle、垂直切片、快照、Python、类型、lint 和文档信号；仅当 diff 要求时增加门禁。

```powershell
pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build
pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test
pnpm --filter @deepseek-ai/dsh-business-bundle test
pnpm --filter @deepseek-ai/dsh-business-tests test
pnpm run verify:a2a-python-v032
pnpm run test:snapshot -t business-a2a-call
pnpm run typecheck
pnpm run lint
pnpm run test:docs
pnpm run doc-sync
git diff --check
```

- [ ] **步骤 2：调用 `superpowers:requesting-code-review`。** 审查协议合规、状态顺序、竞态收敛、Part 转换、清理、精确版本 Python 行为以及五个审查重点。每个接受的问题在修改产品代码前先变成失败回归测试。
- [ ] **步骤 3：只重新运行受审查修复影响的检查，然后运行一次选定的 pre-push 集合。** 不重复已经通过的无关仓库级套件。
- [ ] **步骤 4：检查 `git status --short`、`git diff --stat` 和提交列表。** 确认不存在凭据、生成的环境、本地文件载荷或无关编辑。
- [ ] **步骤 5：调用 `superpowers:verification-before-completion`，报告精确命令和结果，然后调用 `superpowers:finishing-a-development-branch`。** 用户选择集成动作前，不推送、不合并，也不重写远端分支。

## 计划自检

- 已批准设计中的每个验收条件都映射到一个任务和一个具名测试。
- 计划保持插件内扩展，并在不修改 `packages/` 或 `apps/` 的前提下更新完整 Service Definition / Provider / Consumer 表面。
- 计划把结构化交互数据与最终 Artifact 分离，同时复用现有文件处理。
- 每个异步测试使用 barrier、注入式 deadline、自有监听器和等待式清理。
- 每个模型可见变更都包含 Session 快照覆盖和双语运维文档。
- 任何任务都不含占位文件名、未指定的实现选择或无人负责的跨进程资源。
