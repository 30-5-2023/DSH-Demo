# A2A v0.3 文件产物实施计划

[English](2026-09-22-a2a-v03-file-artifacts-implementation.md) | 中文

> **面向 agentic worker：**必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐项实施本计划。步骤使用 checkbox（`- [ ]`）语法跟踪。

**目标：**与 Python `a2a-sdk==0.3.2` 实现精确字节的文件输入和输出互操作，小文件使用内联字节，大文件使用 Bridge 持久托管的 URL。

**架构：**聚焦的文件传输服务通过 DSH attachment 校验并快照每个文件，独立的持久链接服务拥有不透明下载 capability。Executor 通过 Session file upload 暂存入站文件并打开 Task 作用域的发布窗口；模型工具把本地文件发布到该窗口，出站客户端使用同一传输服务发送和落地文件。

**技术栈：**TypeScript、Cordis、Node.js 流与 HTTP、Express 5.2.1、`@a2a-js/sdk` 1.2.0 legacy v0.3 adapter、DSH attachment 与 file upload、storage domain、Node test runner、PowerShell、Python `a2a-sdk==0.3.2`、httpx、Starlette/Uvicorn。

**规格：**[A2A v0.3 文件产物设计](../specs/2026-09-22-a2a-v03-file-artifacts-design.zh.md)

## 全局约束

- 所有产品改动保留在 `business-agent/`；消费现有服务，不修改 `packages/` 或 `apps/`。
- 按照 Python `a2a-sdk==0.3.2` 发出的格式精确接收 A2A v0.3 文件；本次交付不声明 v1.0 文件验收。
- 保留现有文本、数据、v0.3 和 v1.0 行为与测试。
- 大小不超过 `inlineFileMaxBytes` 时使用 `FileWithBytes`，超过时使用 `FileWithUri`；默认内联 1 MiB、文件最大 256 MiB、链接保留 24 小时。
- 文件系统、HTTP 和 attachment 传输采用流式处理，支持取消和实测字节限制；不得只为转换 base64 而收集大型 URI 或本地文件。
- 只通过 `ctx.attachments` 存储规范字节；通过 `ctx.fileUploads` 暂存入站 Session 文件，只通过 `fileHostPath` 暴露本地落地文件。
- 从调用 Session 工作区和配置的绝对根目录解析本地路径，拒绝根目录逃逸和逃逸符号链接，并检测读取过程中的变化。
- 入站 URI origin 只有明确列出时才允许；出站结果 URI 允许来自提供的 Agent Card origin 或配置 origin；每次重定向都重新校验并拒绝 HTTPS 降级。
- 下载 URL 只托管在独立 A2A 监听器上，由 `publicBaseUrl` 生成，并通过随机不透明 token 授权至过期。
- 预研部署不增加用户认证；共享 DSH Web 监听器不得开放下载路由。
- 使用 Cordis effect 和等待完成、幂等的清理。Task 完成时不得发布缺少持久链接记录的 URI。
- 每个实施切片先编写失败的聚焦测试，观察指定失败，再添加最小通过代码并提交。

## 审查重点

1. v0.3 body 中的非规范 base64 可能被 SDK 的 `Buffer.from` 接受；原始 JSON middleware 必须在兼容转换前拒绝它。
2. 已允许 URI 重定向到未列出的 origin、发生 HTTPS 降级或产生无尽、超限流时，必须停止，且不能发布部分 Session prompt 或本地结果。
3. 本地路径的符号链接逃逸允许根目录，或其 inode、大小、时间戳在流式读取期间变化时，即使初始词法路径安全也必须失败。
4. 并发 A2A Task 不得向彼此的 Session 发布文件，也不得在自身发布窗口关闭后继续收集文件。
5. 托管文件必须在 Bridge 重启后持续有效至过期，过期返回 410，未知 token 返回 404，并在客户端断开时释放 attachment reader。

## 文件映射

- 修改 `business-agent/plugins/a2a-bridge/package.json`，增加 attachment 和 file-upload 服务依赖。
- 修改 `src/types.ts` 和 `src/config.ts`，增加文件设置、品牌化 token、传输记录、结果字段、失败和运行时依赖。
- 创建 `src/file-transfer.ts`，负责文件名/媒体校验、有界流、URI 获取、本地快照、Part 构建和本地落地。
- 创建 `src/file-links.ts`，负责新的 version-1 `a2a_bridge_file_links` 元数据 domain 和过期 capability 签发。
- 创建 `src/publication.ts`，负责 Task 作用域发布窗口和 `publish_a2a_file` 工具。
- 修改 `src/conversion.ts` 和 `src/executor.ts`，实现有序入站文件准入和完成 Artifact 组装。
- 修改 `src/http-app.ts` 和 `src/server.ts`，实现规范 v0.3 字节校验和独立下载路由。
- 修改 `src/client.ts` 和 `src/tool.ts`，实现出站本地文件和远端结果落地。
- 修改 `src/index.ts`，完成服务注入、组合、工具注册、启动清理和导出。
- 扩展 `test/config-card.test.mjs`、`store.test.mjs`、`conversion-safe-fetch.test.mjs`、`execution.test.mjs`、`server.test.mjs`、`client-tool.test.mjs` 和 `plugin-lifecycle.test.mjs` 中的聚焦测试；创建 `test/file-transfer.test.mjs` 和 `test/publication.test.mjs`。
- 扩展 `business-agent/tests/fixtures/a2a-python-v032-peer.py`、`python-v032-interop.test.mjs` 和 `verify-a2a-python-v032.ps1`，覆盖精确版本文件用例。
- 修改 Bundle 配置/测试、插件和 Business Agent README 双语对、模型可见快照，以及现有 A2A Agent Note 双语对与配对记录。

## 任务 1：增加文件配置和运行时契约

**文件：**修改 `business-agent/plugins/a2a-bridge/package.json`、`src/types.ts`、`src/config.ts`、`src/index.ts` 和 `test/config-card.test.mjs`。

**接口：**在 `ResolvedA2AConfigCore` 上产出解析后的数值限制和 URL/根目录列表、`A2AOutboundFileInput`、`A2AMaterializedFile`、扩展的调用输入/结果，以及 `attachments` 和 `fileUploads` 所需 Cordis 注入。

- [ ] **步骤 1：编写失败的配置和 schema 测试。**断言默认值 `inlineFileMaxBytes=1_048_576`、`maxFileBytes=268_435_456`、`fileRetentionMs=86_400_000`、`maxRequestBytes=2_097_152`、空 origin/根目录列表，以及 Card 输入输出模式都包含 `application/octet-stream`；拒绝内联限制大于最大值、body 限制小于 `4 * ceil(inline / 3) + 65_536`、非 origin URL、非绝对根目录，以及 1 分钟到 30 天范围外的保留期。
- [ ] **步骤 2：运行聚焦测试并观察缺失字段。**运行 `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/config-card.test.mjs`；预期新解析字段和 Card mode 断言失败。
- [ ] **步骤 3：增加精确的公开和解析后类型。**定义以下字段并保留现有名称：

```ts
export interface A2AOutboundFileInput { readonly path: string; readonly name?: string; readonly mime_type?: string }
export interface A2AMaterializedFile { readonly path: string; readonly name: string; readonly mime_type: string; readonly bytes: number; readonly artifact_id: string }
export interface CallA2AAgentInput { readonly files?: readonly A2AOutboundFileInput[] /* existing fields remain */ }
export interface CallA2AAgentResult { readonly files?: readonly A2AMaterializedFile[] /* existing fields remain */ }
```

- [ ] **步骤 4：解析并校验部署值。**增加 Schemastery 字段和明确的 `resolveFileOrigins()`、`resolveAllowedRoots()` helper；通过 `new URL(value).origin` 规范化 origin，拒绝凭据/query/fragment/path，在不要求启动时存在的前提下把根目录解析为绝对路径，并执行 base64 body 预算公式。
- [ ] **步骤 5：增加包服务和 fail-loud 注入。**增加 `@deepseek-ai/dsh-attachment`、`@deepseek-ai/dsh-client-file-upload` 的 peer/dev dependency，导入其 Cordis augmentation，并把 `inject` 改为 `['webServer', 'sessionController', 'storageDomain', 'tools', 'attachments', 'fileUploads']`。
- [ ] **步骤 6：运行聚焦测试和构建。**重复步骤 2；预期所有旧有和新增配置/Card 断言通过。
- [ ] **步骤 7：提交契约切片。**运行 `git add business-agent/plugins/a2a-bridge/{package.json,src/types.ts,src/config.ts,src/index.ts,test/config-card.test.mjs} pnpm-lock.yaml && git commit -m "feat(business-agent): configure A2A file transfer"`。

## 任务 2：构建有界文件传输基础

**文件：**创建 `business-agent/plugins/a2a-bridge/src/file-transfer.ts` 和 `test/file-transfer.test.mjs`；修改 `src/types.ts` 和 `src/index.ts` 导出。

**接口：**产出 `A2AFileTransfer.snapshotLocal`、`uploadInboundPart`、`materializePart`，以及纯函数 `safeFileName`、`mediaTypeOrDefault`、`boundedBytes`。

```ts
import type { PromptContentPart } from '@deepseek-ai/dsh-api-session-controller'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
type Part = object
interface A2AOutboundFileInput { readonly path: string; readonly name?: string; readonly mime_type?: string }
export interface StoredA2AFile { readonly ref: FileAttachmentRef; readonly mediaType: string }
export declare class A2AFileTransfer {
  snapshotLocal(input: A2AOutboundFileInput, workspaceRoot: string, signal: AbortSignal): Promise<StoredA2AFile>
  uploadInboundPart(part: Part, sessionId: SessionId, allowedOrigin: (url: URL) => boolean, signal: AbortSignal): Promise<PromptContentPart>
  materializePart(part: Part, allowedOrigin: (url: URL) => boolean, signal: AbortSignal): Promise<StoredA2AFile & { readonly path: string }>
}
```

- [ ] **步骤 1：编写失败的纯策略测试。**覆盖安全叶名称、缺少 MIME 时默认为 `application/octet-stream`、无效 MIME 拒绝、伪造 `Content-Length` 时实测字节超限、取消、HTTP 凭据/fragment、未列出重定向 origin、重定向上限和 HTTPS 降级。
- [ ] **步骤 2：编写审查重点中的本地路径测试。**在临时工作区中接受常规相对文件，拒绝 `..` 逃逸和逃逸符号链接，接受实际目标仍位于根内的符号链接，并在首个分块后修改文件，使快照拒绝而不是返回引用。
- [ ] **步骤 3：运行新测试并观察模块缺失。**运行 `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/file-transfer.test.mjs`；预期 module/export 失败。
- [ ] **步骤 4：实现有界流和 URI 策略。**每个分块在转发前计数，超限时取消 response body，首次请求和每次重定向前应用 origin predicate，使用现有 fetch policy 设置 deadline，并把失败映射为不同的 `A2ABridgeErrorCode` 成员。
- [ ] **步骤 5：实现稳定本地快照。**通过 `realpath` 解析工作区和允许根目录，只打开目标一次，要求常规文件，把该 handle 的流写入 `attachments.saveFileStream`，比较读取前后 handle stat 的 `dev`、`ino`、`size`、`mtimeMs`、`ctimeMs`，并在 `finally` 关闭 handle。
- [ ] **步骤 6：实现 Session 上传和本地投影。**raw Part 通过 `fileUploads.uploadStream` 流式传输 Buffer；URL Part 通过同一 API 流式传输有界 HTTP body。远端输出通过 attachment 保存，并要求 `attachments.fileHostPath(ref)` 返回绝对路径，否则抛出 `A2A_ATTACHMENT_PATH_UNAVAILABLE`。
- [ ] **步骤 7：运行新测试和现有 conversion/fetch 回归测试。**运行步骤 3 命令，然后运行 `node --test business-agent/plugins/a2a-bridge/test/conversion-safe-fetch.test.mjs`；预期两个测试集都通过。
- [ ] **步骤 8：提交传输切片。**运行 `git add business-agent/plugins/a2a-bridge/src/{file-transfer,types,index}.ts business-agent/plugins/a2a-bridge/test/{file-transfer,conversion-safe-fetch}.test.mjs && git commit -m "feat(business-agent): stream A2A files safely"`。

## 任务 3：持久化可过期的托管文件链接

**文件：**创建 `business-agent/plugins/a2a-bridge/src/file-links.ts`；修改 `src/types.ts`、`src/index.ts`、`test/store.test.mjs` 和 `test/plugin-lifecycle.test.mjs`。

**接口：**产出独立的 version-1 元数据 domain，避免改变现有 `a2a_bridge` Task domain 和已部署记录。

```ts
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Branded } from '@deepseek-ai/dsh-brand'
type A2ATaskId = Branded<'A2ATaskId'>
export type A2AFileToken = Branded<'A2AFileToken'>
interface StoredA2AFile { readonly ref: FileAttachmentRef; readonly mediaType: string }
export interface A2AFileLinkRecord { readonly token: A2AFileToken; readonly taskId: A2ATaskId; readonly ref: FileAttachmentRef; readonly mediaType: string; readonly createdAt: string; readonly expiresAt: string }
export interface A2AFileLinkRepository { put(record: A2AFileLinkRecord): Promise<void>; get(token: A2AFileToken): Promise<A2AFileLinkRecord | undefined>; delete(token: A2AFileToken): Promise<void>; reapExpired(now: string): Promise<number>; close(): Promise<void> }
export declare class A2AFileLinks { issue(file: StoredA2AFile, taskId: A2ATaskId): Promise<URL>; resolve(token: string): Promise<{ readonly kind: 'found'; readonly record: A2AFileLinkRecord } | { readonly kind: 'expired' } | { readonly kind: 'missing' }> }
```

- [ ] **步骤 1：编写失败的持久化测试。**打开 JSON-backed storage，为相同 attachment 字节签发两个链接，断言不同的 256-bit base64url token，关闭后重新打开并解析两条记录，把注入时钟推进到过期之后，断言 `expired`，并断言择机回收只删除过期记录。
- [ ] **步骤 2：编写生命周期失败测试。**让链接持久化拒绝并断言不返回 URL；让 repository close 在部分启动时拒绝，并断言原始启动失败与清理失败出现在同一个 `AggregateError` 中。
- [ ] **步骤 3：运行聚焦测试并观察导出缺失。**运行 `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/store.test.mjs business-agent/plugins/a2a-bridge/test/plugin-lifecycle.test.mjs`；预期 file-link symbol 不存在。
- [ ] **步骤 4：定义独立元数据 domain。**使用 `defineDomain({ name: 'a2a_bridge_file_links', version: 1, tables: { links: domainTable(schema) } })`；通过 zod 校验 token、Task id、attachment id/name/bytes、媒体类型和 ISO 时间戳。
- [ ] **步骤 5：实现签发和过期。**生成 `randomBytes(32).toString('base64url')`，持久化后才返回，通过 `publicBaseUrl` 构建 `<route>/files/<token>`，删除过期记录的同时返回 410 状态，并在启动和签发期间回收过期条目。
- [ ] **步骤 6：组合并关闭两个 repository。**在发布监听器前打开 Task 和 link repository；把 link repository 纳入部分启动和正常清理，同时不改变现有 Task domain version。
- [ ] **步骤 7：运行聚焦测试。**重复步骤 3；预期重启、过期、唯一性和生命周期用例通过。
- [ ] **步骤 8：提交持久化切片。**运行 `git add business-agent/plugins/a2a-bridge/src/{file-links,types,index}.ts business-agent/plugins/a2a-bridge/test/{store,plugin-lifecycle}.test.mjs && git commit -m "feat(business-agent): persist A2A file links"`。

## 任务 4：把入站 v0.3 文件接收到 Session

**文件：**修改 `src/conversion.ts`、`src/executor.ts`、`src/http-app.ts`、`src/types.ts`、`test/conversion-safe-fetch.test.mjs`、`test/execution.test.mjs` 和 `test/server.test.mjs`。

**接口：**把 `a2aMessageToPrompt` 改为异步准入，接收 `sessionId`、`A2AFileTransfer`、origin predicate 和 `AbortSignal`；返回相同的有序 `UserContent` 与请求输出模式。

- [ ] **步骤 1：编写失败的转换测试。**传入 `[TextPart, raw Part, DataPart, URL Part]`，断言 prompt 顺序为 `[text, file receipt, labeled data text, file receipt]`，文件名和 MIME 值精确，并且只有在不存在非空文本、数据或文件时才返回 `A2A_EMPTY_MESSAGE`。
- [ ] **步骤 2：编写失败的 executor 原子性测试。**让两个文件中的第二个超过 `maxFileBytes`；断言不调用 `sessionController.prompt`，Task 以 `A2A_FILE_TOO_LARGE` 失败结束，并且取消操作会中止活动 upload/fetch。
- [ ] **步骤 3：编写规范 base64 Server 测试。**POST 一个 v0.3 `message/send`，其 `file.bytes` 能被 `Buffer.from` 解码但不是规范编码；预期 JSON-RPC invalid params 且 executor 调用数为零，然后发送规范空字节和非空字节文件并预期分派。
- [ ] **步骤 4：运行聚焦测试并观察 unsupported-Part 失败。**构建并运行三个测试文件；预期 raw/URL Part 失败，格式错误 base64 进入 SDK。
- [ ] **步骤 5：增加原始 JSON v0.3 文件校验。**在 `express.json` 之后、`jsonRpcHandler` 之前，只检查 v0.3 `kind: 'file'` Part，要求 `bytes`、`uri` 必须且只能有一个，并要求 `Buffer.from(bytes, 'base64').toString('base64') === bytes`；其余协议校验继续交给 SDK。
- [ ] **步骤 6：重排 executor 准入。**在 I/O 前保留未知 context 拒绝，创建或恢复 Session，使用精确请求 signal 调用异步转换，并且只在所有 Part 和 upload 成功后调用 `sessionController.prompt`。
- [ ] **步骤 7：运行聚焦测试和现有文本/数据回归。**重复步骤 4；预期有序混合内容、规范编码校验、prompt 原子性和旧文本/JSON 用例通过。
- [ ] **步骤 8：提交入站准入。**运行 `git add business-agent/plugins/a2a-bridge/src/{conversion,executor,http-app,types}.ts business-agent/plugins/a2a-bridge/test/{conversion-safe-fetch,execution,server}.test.mjs && git commit -m "feat(business-agent): admit A2A v0.3 file inputs"`。

## 任务 5：发布 Task 作用域的 Agent 输出文件

**文件：**创建 `src/publication.ts` 和 `test/publication.test.mjs`；修改 `src/executor.ts`、`src/tool.ts`、`src/types.ts`、`src/index.ts`、`test/execution.test.mjs` 和 `test/client-tool.test.mjs`。

**接口：**产出一个发布 registry 和一个工具，其成功结果绝不包含文件字节或 capability token。

```ts
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Branded } from '@deepseek-ai/dsh-brand'
type A2ATaskId = Branded<'A2ATaskId'>
interface StoredA2AFile { readonly ref: FileAttachmentRef; readonly mediaType: string }
declare class A2AFileTransfer {}
export interface PublishedA2AFile extends StoredA2AFile { readonly name: string }
export interface A2APublicationWindow extends Disposable { files(): readonly PublishedA2AFile[] }
export declare class A2AFilePublications { open(taskId: A2ATaskId, sessionId: SessionId): A2APublicationWindow; publish(sessionId: SessionId, file: PublishedA2AFile): void }
export declare function createPublishA2AFileTool(publications: A2AFilePublications, transfer: A2AFileTransfer): ToolDefinition
```

- [ ] **步骤 1：编写失败的工具测试。**断言 `publish_a2a_file` 要求 `exec.agent`，要求该 Session 存在活动窗口，从 `exec.agent.session.header.cwd` 解析路径，立即快照，只返回 `{ name, mime_type, bytes, attachment_id }`，并拒绝窗口关闭后的调用。
- [ ] **步骤 2：编写审查重点中的隔离测试。**为两个 Session 和 Task 打开窗口，并发发布，断言每个窗口只看到自身有序文件，拒绝同一 Session 的第二个窗口，并断言取消/失败会关闭窗口且不把文件附加到 Task。
- [ ] **步骤 3：编写 Artifact 阈值测试。**发布一个大小恰好等于 `inlineFileMaxBytes` 的文件和一个大一字节的文件；断言完成 Artifact 的 Part 为 text、raw、URL，链接签发发生在终态 Task 持久化前，并且链接写入失败会使 Task 失败。
- [ ] **步骤 4：运行聚焦测试并观察工具/registry 缺失。**构建并运行 `publication.test.mjs`、`execution.test.mjs` 和 `client-tool.test.mjs`；预期缺少导出和工具 schema 失败。
- [ ] **步骤 5：实现 registry 和工具。**按品牌化 Session id 索引活动窗口，在 executor `finally` 中关闭，`publish` 前调用 `snapshotLocal`，在 `call_a2a_agent` 旁注册工具，并让工具 presentation 显示安全文件名而非源路径。
- [ ] **步骤 6：组装最终 Artifact。**增加 `A2AFileTransfer.toPart(file, taskId)`；raw Part 最多收集 1 MiB，更大引用签发持久 URL，把 Part 追加到现有 `result` Artifact 的文本/数据之后，持久化携带 Artifact 的 Task，发布一次最终 replacement update，然后进入 completed。
- [ ] **步骤 7：运行聚焦测试。**重复步骤 4；预期工具作用域、隔离、阈值、链接失败结算和现有输出行为通过。
- [ ] **步骤 8：提交输出发布。**运行 `git add business-agent/plugins/a2a-bridge/src/{publication,executor,tool,types,index}.ts business-agent/plugins/a2a-bridge/test/{publication,execution,client-tool}.test.mjs && git commit -m "feat(business-agent): publish A2A file artifacts"`。

## 任务 6：从独立监听器提供大文件

**文件：**修改 `src/http-app.ts`、`src/server.ts`、`src/types.ts`、`test/server.test.mjs` 和 `test/plugin-lifecycle.test.mjs`。

**接口：**为 HTTP application 增加可选、仅限独立模式的 `A2AFileDownloadHandler` 依赖；共享模式不传 handler，因此不拥有下载路由。

```ts
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Branded } from '@deepseek-ai/dsh-brand'
type A2AFileToken = Branded<'A2AFileToken'>
type A2ATaskId = Branded<'A2ATaskId'>
interface A2AFileLinkRecord { readonly token: A2AFileToken; readonly taskId: A2ATaskId; readonly ref: FileAttachmentRef; readonly mediaType: string; readonly createdAt: string; readonly expiresAt: string }
export interface A2AFileDownloadHandler { handle(token: string, method: 'GET' | 'HEAD', signal: AbortSignal): Promise<{ readonly status: 200; readonly record: A2AFileLinkRecord; readonly body?: AsyncIterable<Uint8Array> } | { readonly status: 404 | 410 }> }
```

- [ ] **步骤 1：编写失败的路由测试。**签发一个链接，调用 `HEAD` 和 `GET`，断言精确的 `Content-Type`、`Content-Length`、安全 UTF-8 `Content-Disposition`、`nosniff` 和精确流字节；断言 POST 返回 405、Range 返回 416、未知返回 404、过期返回 410。
- [ ] **步骤 2：编写监听器分离和断开测试。**断言共享 Web 监听器对文件 URL 返回 404，独立监听器成功，并且客户端在下载中途断开会中止 `readFileStream` signal，使 `server.close()` 可以完成。
- [ ] **步骤 3：运行 Server 测试并观察 404。**构建并运行 `server.test.mjs` 和 `plugin-lifecycle.test.mjs`；预期所有下载请求 miss。
- [ ] **步骤 4：实现独立下载路由。**仅在存在 `config.listener` 和 download handler 时挂载 `GET|HEAD ${config.route}/files/:token`，repository lookup 前校验 base64url token，流式传输前设置响应头，使用 `Readable.from(iterable).pipe(response)`，并在 request/response close 时销毁 reader。
- [ ] **步骤 5：保持完全停稳关闭。**把下载纳入现有活动响应集合，关闭 HTTP Server 前停止准入，在关闭 link 和 attachment 依赖前等待所有已接收 HEAD/GET 响应。
- [ ] **步骤 6：运行聚焦测试。**重复步骤 3；预期路由、状态、响应头、流、断开、隔离和关闭用例通过。
- [ ] **步骤 7：提交下载端点。**运行 `git add business-agent/plugins/a2a-bridge/src/{http-app,server,types}.ts business-agent/plugins/a2a-bridge/test/{server,plugin-lifecycle}.test.mjs && git commit -m "feat(business-agent): serve A2A file downloads"`。

## 任务 7：发送本地文件并落地远端输出

**文件：**修改 `src/client.ts`、`src/tool.ts`、`src/types.ts`、`test/client-tool.test.mjs` 和 `test/file-transfer.test.mjs`。

**接口：**扩展 `A2AAgentClient.call(input, signal, workspaceRoot?)`；不携带 `files` 的现有调用方保持源码兼容。工具在存在文件时传递自身 Session cwd。

- [ ] **步骤 1：扩展远端 fixture。**记录入站 Part 顺序，通过 replacement 和 append Artifact update 返回 text、raw、URL Part；使 URL 响应流可配置为成功、重定向、超限和断开。
- [ ] **步骤 2：编写失败的出站输入测试。**使用文本消息和两个跨越阈值的本地文件调用，断言 text/raw/URL 顺序、文件名和 MIME 保留，并断言大型 URL 从调用方独立端点下载到精确字节。
- [ ] **步骤 3：编写失败的输出落地测试。**断言 `result.output` 保留文本/JSON，`result.files` 保留最终 Artifact 顺序并返回绝对 `path`、`name`、`mime_type`、`bytes` 和 `artifact_id`；读取每条路径并比较 SHA-256。断言不支持 Part 会失败而不是消失。
- [ ] **步骤 4：增加审查重点中的 URI 失败。**返回同 origin URI 后重定向到未列出 origin、超限流和取消流；断言稳定失败、没有 `files` 结果、没有可读取部分路径。
- [ ] **步骤 5：运行聚焦 Client 测试并观察字段缺失。**构建并运行 `client-tool.test.mjs` 和 `file-transfer.test.mjs`；预期工具 schema、出站 Part 和落地断言失败。
- [ ] **步骤 6：准备出站 Part。**相对于 `workspaceRoot` 快照每个 `files` 条目，把 `toPart()` 结果追加到现有消息 Part 之后，提供文件时要求 workspace，并保留现有传输选择、超时、context、接受输出模式和取消行为。
- [ ] **步骤 7：异步收集输出。**把 `outputFromParts` 替换为异步 collector，分离文本/数据和 raw/URL，使用 Agent Card origin 与配置 origin 落地 URL，赋予所属 Artifact id，并通过 `assertNever` 拒绝未知 content case。
- [ ] **步骤 8：扩展模型可见 schema 和渲染。**增加 `files` 输入和结果数组，渲染中不包含字节，传入 `exec.agent.session.header.cwd`，并保持六个现有字段不变。
- [ ] **步骤 9：运行聚焦测试。**重复步骤 5；预期 v0.3/v1 回归、阈值 Part、路径落地、URI 失败和工具 schema 通过。
- [ ] **步骤 10：提交出站文件。**运行 `git add business-agent/plugins/a2a-bridge/src/{client,tool,types}.ts business-agent/plugins/a2a-bridge/test/{client-tool,file-transfer}.test.mjs && git commit -m "feat(business-agent): exchange A2A call files"`。

## 任务 8：证明精确 Python 0.3.2 文件互操作

**文件：**修改 `business-agent/tests/fixtures/a2a-python-v032-peer.py`、`business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs` 和 `business-agent/verify-a2a-python-v032.ps1`。

**接口：**保留 `client BASE_URL` 和 `server` 模式；增加临时目录参数，并输出包含 SHA-256、文件名、MIME 类型、Part 顺序和已下载 URI 字节的紧凑 JSON verdict。

- [ ] **步骤 1：扩展 Python import 和 helper。**使用包原生 `FilePart`、`FileWithBytes`、`FileWithUri`；使用 httpx 实现流式 URI 下载和 SHA-256，不把大文件解码到 JSON verdict 中。
- [ ] **步骤 2：增加 Python 到 DSH 用例。**发送一个混合文本/数据/字节/URI 消息，其中两个文件具有不同字节和元数据；随后调用让 Business Agent 发布一个小文件和一个大文件的命令，验证 Task Artifact 文件类别并下载 URI 文件。
- [ ] **步骤 3：增加 DSH 到 Python 用例。**让 Python executor 检查输入 FilePart、下载 URI 输入并校验 hash，返回一个 `FileWithBytes` 和一个 `FileWithUri`；Node 测试使用两个本地文件调用并验证每个落地结果路径。
- [ ] **步骤 4：在没有 Python 时运行常规 JavaScript suite。**运行 `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test`；预期精确版本测试自跳过，其他测试全部通过。
- [ ] **步骤 5：运行固定环境并在完成 fixture 前观察失败。**运行 `powershell -NoProfile -File business-agent/verify-a2a-python-v032.ps1`；预期缺少文件 verdict 字段，然后完成 fixture 接线，直到同一命令通过并报告 `a2a-sdk 0.3.2`。
- [ ] **步骤 6：增加字节边界断言。**使用恰好 1 MiB 和 1 MiB 加一字节的负载，断言 bytes 与 URI 类别，并验证双向精确 SHA-256 值。
- [ ] **步骤 7：提交精确版本互操作。**运行 `git add business-agent/tests/fixtures/a2a-python-v032-peer.py business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs business-agent/verify-a2a-python-v032.ps1 && git commit -m "test(business-agent): prove A2A 0.3 file interop"`。

## 任务 9：接入部署默认值、文档、快照和最终门禁

**文件：**修改 `business-agent/bundle/cordis.patch.yml`、`business-agent/bundle/test/config.mjs`、`business-agent/plugins/a2a-bridge/README.md`、`.zh.md` 和配对记录；修改 `business-agent/README.md`、`.zh.md` 和配对记录；更新相关迁移文档、快照，以及 `.agents/notes/implemented/feature/2026-09-20-a2a-bridge.md`、`.zh.md` 和配对记录。

**接口：**Bundle 默认值匹配任务 1，并允许通过环境变量覆盖 origin、根目录、阈值、最大大小和保留期，不把物理机 IP 写入镜像。

- [ ] **步骤 1：让 Bundle 测试期待文件策略。**断言数值默认值、`application/octet-stream` mode、空数组，以及逗号分隔精确 origin 和绝对根目录的环境变量解析；格式错误值必须在 profile 启动前拒绝。
- [ ] **步骤 2：运行 Bundle 测试并观察缺失配置。**运行 `pnpm --filter @deepseek-ai/dsh-business-agent test`；预期文件策略断言失败。
- [ ] **步骤 3：增加运行时所有的 Bundle 值。**设置 `maxRequestBytes: 2097152`、三个文件默认值，以及允许 origin 和根目录的 `!!js` 表达式；保持 `A2A_PUBLIC_BASE_URL` 为唯一声明地址。
- [ ] **步骤 4：更新双语运行文档。**记录 Python 0.3.2 类型、本地路径含义、小/大文件阈值、URI allowlist、下载有效期、Docker/Kubernetes 地址注入、`publish_a2a_file`、`call_a2a_agent.files`、落地结果路径、无认证限制和复制/部署要求；重新生成每个已修改的配对记录。
- [ ] **步骤 5：更新现有 Agent Note 和快照。**用交付的文件决策替换仅文本/JSON 描述，记录独立链接元数据 domain 和 attachment 所有权，为两个模型可见工具更新快照，并且只重新录制受影响的 snapshot case。
- [ ] **步骤 6：运行聚焦包和部署检查。**运行 `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build`、其 package test、Bundle test 和 `powershell -NoProfile -File business-agent/verify-a2a-python-v032.ps1`；预期零失败和精确 Python 版本 verdict。
- [ ] **步骤 7：运行 `dsh-pre-push-checks` 选择的仓库门禁。**至少运行 `pnpm run typecheck`、`pnpm run lint`、`pnpm run test:docs`、`pnpm run doc-sync`、受影响的录制快照命令和 `git diff --cached --check`；精确报告任何仅由宿主环境导致的跳过或失败。
- [ ] **步骤 8：请求全分支审查。**调用 `superpowers:requesting-code-review`，使用聚焦红—绿测试处理接受的发现，只重新运行覆盖所改发现的检查，并保留无关 worktree 改动。
- [ ] **步骤 9：提交部署和文档切片。**只暂存列出的 Business Agent、snapshot 和 Agent Note 文件，运行 `git commit -m "docs(business-agent): document A2A file artifacts"`。
- [ ] **步骤 10：有意完成分支。**调用 `superpowers:finishing-a-development-branch`，展示已验证的集成选项，在用户选择前不合并也不推送。
