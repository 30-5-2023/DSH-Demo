import type { AgentCard, Message, Part, Task } from '@a2a-js/sdk'
import type {
  PromptContentPart,
  SessionController,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import type { A2AQuestionBroker } from './interaction.ts'

/** Safe diagnostic returned with a repeated input-required question. */
export interface A2AInteractionError {
  readonly code: 'A2A_INTERACTION_INVALID_RESPONSE'
  readonly message: string
}

/** Parsed response or safe validation failure from an A2A Message. */
export type ParsedInteractionAnswer =
  | { readonly ok: true; readonly answer: AskUserQuestionAnswer }
  | { readonly ok: false; readonly error: A2AInteractionError }

/** One live Task's exclusive human-question window. */
export interface A2AQuestionWindow extends Disposable {
  readonly taskId: A2ATaskId
  /** @returns Whether a DSH question currently awaits an A2A continuation. */
  hasPendingQuestion(): boolean
  /**
   * Validate and commit one continuation before releasing the waiting tool call.
   * @param message - Caller Message addressed to this Task.
   * @returns Accepted, invalid, or duplicate delivery outcome.
   */
  continue(message: Message): Promise<'accepted' | 'invalid' | 'duplicate'>
}

/** Session identity, cancellation, and persisted status publishers for one Task. */
export interface A2AQuestionWindowOptions {
  readonly taskId: A2ATaskId
  readonly contextId: A2AContextId
  readonly sessionId: SessionId
  readonly signal: AbortSignal
  /** Persist and publish the question status before the tool wait becomes externally answerable. */
  readonly publishInputRequired: (message: Message) => Promise<void>
  /** Persist and publish working status before the pending DSH tool call resolves. */
  readonly publishWorking: () => Promise<void>
}

/** Stable A2A context identity owned by the bridge. */
export type A2AContextId = Branded<'A2AContextId'>
/** Admit a protocol context identifier at the bridge boundary. */
export function A2AContextId(value: string): A2AContextId {
  return brandString<A2AContextId>(value)
}
/** Stable A2A task identity owned by the bridge. */
export type A2ATaskId = Branded<'A2ATaskId'>
/** Admit a protocol Task identifier at the bridge boundary. */
export function A2ATaskId(value: string): A2ATaskId {
  return brandString<A2ATaskId>(value)
}
/** Caller-provided A2A message identity used for idempotency. */
export type A2AMessageId = Branded<'A2AMessageId'>
/** Admit a caller-provided message identifier at the bridge boundary. */
export function A2AMessageId(value: string): A2AMessageId {
  return brandString<A2AMessageId>(value)
}
/** Opaque 256-bit capability identifying one hosted A2A file. */
export type A2AFileToken = Branded<'A2AFileToken'>
/** Admit a validated hosted-file capability at the bridge boundary. */
export function A2AFileToken(value: string): A2AFileToken {
  return brandString<A2AFileToken>(value)
}

/** Durable ownership relationship between one A2A context and one DSH Session. */
export interface A2AContextRecord {
  readonly contextId: A2AContextId
  readonly sessionId: SessionId
  readonly createdAt: string
  readonly updatedAt: string
}

/** Persistence operations required by inbound execution and SDK Task storage. */
export interface A2ARepository {
  getContext(contextId: A2AContextId): Promise<A2AContextRecord | undefined>
  createContext(record: A2AContextRecord): Promise<void>
  /**
   * Observe a durable snapshot synchronously under the same lock as Task mutations.
   * @param taskId - Durable Task identity.
   * @param observe - Optional synchronous observer called before releasing the repository lock.
   * @returns The current Task, or undefined when absent.
   */
  getTask(taskId: A2ATaskId, observe?: (task: Task) => void): Promise<Task | undefined>
  getTaskByMessageId(messageId: A2AMessageId): Promise<Task | undefined>
  saveTask(task: Task, inputMessageId?: A2AMessageId): Promise<void>
  /**
   * Mutate the latest Task under the repository write lock; returning it unchanged performs no write.
   * @param taskId - Task to read and replace atomically.
   * @param update - Synchronous mutation of the latest durable Task, or undefined before creation.
   * @returns The Task selected by the mutation after persistence completes.
   */
  updateTask(taskId: A2ATaskId, update: (task: Task | undefined) => Task): Promise<Task>
  markInterruptedTasksFailed(now: string): Promise<number>
  close(): Promise<void>
}

/** Durable hosted-file capability metadata. */
export interface A2AFileLinkRecord {
  readonly token: A2AFileToken
  readonly taskId: A2ATaskId
  readonly ref: FileAttachmentRef
  readonly mediaType: string
  readonly createdAt: string
  readonly expiresAt: string
}

/** Persistence operations required by hosted A2A file downloads. */
export interface A2AFileLinkRepository {
  put(record: A2AFileLinkRecord): Promise<void>
  get(token: A2AFileToken): Promise<A2AFileLinkRecord | undefined>
  delete(token: A2AFileToken): Promise<void>
  reapExpired(now: string): Promise<number>
  close(): Promise<void>
}

/** Dedicated-listener dependency that resolves and streams hosted A2A files. */
export interface A2AFileDownloadHandler {
  handle(
    token: string,
    method: 'GET' | 'HEAD',
    signal: AbortSignal,
  ): Promise<
    | { readonly status: 200; readonly record: A2AFileLinkRecord; readonly body?: AsyncIterable<Uint8Array> }
    | { readonly status: 404 | 410 }
  >
}

/** Per-context admission, cancellation, and quiescent shutdown for A2A work. */
export interface ContextScheduler {
  /**
   * Queue an operation behind earlier work for the same context.
   * @param taskId - Unique task identity used for cancellation.
   * @param contextId - Context whose operations execute serially.
   * @param operation - Abort-aware work started after admission.
   * @returns The operation's eventual result.
   */
  run<T>(
    taskId: A2ATaskId,
    contextId: A2AContextId,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>
  /**
   * Cancel an admitted task.
   * @param taskId - Task to remove or abort.
   * @returns The task's phase when cancellation was requested.
   */
  cancel(taskId: A2ATaskId): 'queued' | 'active' | 'missing'
  /** @returns Fulfillment after queued work is rejected and active work settles. */
  close(): Promise<void>
}

/** Exact Session turn settlement observed for one accepted prompt request. */
export interface TrackedSessionTurn {
  readonly turn: number
  readonly text: string
  readonly reason: TurnEndReason
}

/** Correlates one Session Controller request with its durable turn and live text. */
export interface SessionTurnTracker {
  /**
   * Observe the exact turn that admits one Session Controller request.
   * @param input - Session/request identity, cancellation, and live text sink.
   * @returns Durable text and settlement reason from the owned turn.
   */
  track(input: {
    readonly sessionId: SessionId
    readonly requestId: SessionRequestId
    readonly signal: AbortSignal
    readonly onTextDelta: (delta: string) => void
  }): Promise<TrackedSessionTurn>
  /** @returns Fulfillment after listeners detach and pending observations reject. */
  close(): Promise<void>
}

/** Prompt content admitted to the Session controller after A2A Part validation. */
export type UserContent = readonly PromptContentPart[]

/** File-admission operation required while converting one inbound message. */
export interface A2AInboundFileTransfer {
  uploadInboundPart(
    part: Part,
    sessionId: SessionId,
    allowedOrigin: (url: URL) => boolean,
    signal: AbortSignal,
  ): Promise<PromptContentPart>
  toPart(file: PublishedA2AFile, taskId: A2ATaskId, signal?: AbortSignal): Promise<Part>
}

/** Session and transfer policy used to admit inbound A2A file Parts. */
export interface A2APromptAdmission {
  readonly sessionId: SessionId
  readonly fileTransfer: A2AInboundFileTransfer
  readonly allowedOrigin: (url: URL) => boolean
  readonly signal: AbortSignal
}

/** Stable bridge failure codes safe for protocol and tool summaries. */
export type A2ABridgeErrorCode =
  | 'A2A_EMPTY_MESSAGE'
  | 'A2A_UNSUPPORTED_PART'
  | 'A2A_INVALID_DATA'
  | 'A2A_INVALID_JSON_OUTPUT'
  | 'A2A_FETCH_URL_REJECTED'
  | 'A2A_FETCH_REDIRECT_LIMIT'
  | 'A2A_FETCH_DOWNGRADE'
  | 'A2A_FETCH_TOO_LARGE'
  | 'A2A_FETCH_TIMEOUT'
  | 'A2A_FETCH_ABORTED'
  | 'A2A_FETCH_FAILED'
  | 'A2A_FILE_NAME_INVALID'
  | 'A2A_MEDIA_TYPE_INVALID'
  | 'A2A_FILE_TOO_LARGE'
  | 'A2A_FILE_URI_REJECTED'
  | 'A2A_FILE_REDIRECT_LIMIT'
  | 'A2A_FILE_DOWNGRADE'
  | 'A2A_FILE_FETCH_TIMEOUT'
  | 'A2A_FILE_FETCH_ABORTED'
  | 'A2A_FILE_FETCH_FAILED'
  | 'A2A_FILE_PATH_REJECTED'
  | 'A2A_FILE_UNSTABLE'
  | 'A2A_FILE_URL_UNAVAILABLE'
  | 'A2A_ATTACHMENT_PATH_UNAVAILABLE'
  | 'A2A_PUBLICATION_WINDOW_MISSING'
  | 'A2A_PUBLICATION_AGENT_REQUIRED'
  | 'A2A_PUBLICATION_WORKSPACE_REQUIRED'
  | 'A2A_CALL_WORKSPACE_REQUIRED'
  | 'A2A_SESSION_CREATE_FAILED'
  | 'A2A_SESSION_PROMPT_FAILED'
  | 'A2A_EXECUTION_TIMEOUT'
  | 'A2A_TURN_FAILED'
  | 'A2A_TASK_CANCELED'

/** Error whose code and message are safe to expose without remote response content. */
export class A2ABridgeError extends Error {
  override readonly name = 'A2ABridgeError'

  constructor(
    readonly code: A2ABridgeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** Transport limits for Agent Card and JSON-RPC HTTP requests. */
export interface FetchPolicy {
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly maxRedirects: number
  readonly signal?: AbortSignal
  /** Injectable transport for deterministic policy tests and custom runtimes. */
  readonly fetchImpl?: typeof fetch
}

/** Abort signal and release operation for one execution deadline. */
export interface ExecutionDeadline {
  readonly signal: AbortSignal
  /** Release the underlying deadline resource after execution settles. */
  close(): void
}

/** Lossless JSON value accepted by the outbound A2A tool. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Model-visible inputs for one remote A2A invocation. */
export interface CallA2AAgentInput {
  readonly agent_card_url: string
  readonly message: string | JsonValue
  readonly files?: readonly A2AOutboundFileInput[]
  readonly context_id?: string
  readonly task_id?: string
  readonly stream?: boolean
  readonly accepted_output_mode?: 'text' | 'json'
  readonly timeout_ms?: number
}

/** Text and structured values in an interrupted Task's status Message. */
export interface A2AInteractionResult {
  readonly text?: string
  readonly data?: readonly JsonValue[]
}

/** Compact, safe result returned from one remote A2A invocation. */
export interface CallA2AAgentResult {
  readonly context_id?: string
  readonly task_id?: string
  readonly state: string
  readonly output?: string | JsonValue
  readonly interaction?: A2AInteractionResult
  readonly files?: A2AMaterializedFile[]
  readonly failure?: { readonly code: string; readonly message: string }
}

/** One model-selected local file accompanying an outbound A2A message. */
export interface A2AOutboundFileInput {
  readonly path: string
  readonly name?: string
  readonly mime_type?: string
}

/** One remote file output materialized through the mounted attachment provider. */
export interface A2AMaterializedFile {
  readonly path: string
  readonly name: string
  readonly mime_type: string
  readonly bytes: number
  readonly artifact_id: string
}

/** Stored immutable file bytes and the media type carried by the A2A Part. */
export interface StoredA2AFile {
  readonly ref: FileAttachmentRef
  readonly mediaType: string
}

/** File explicitly published by the Agent for its completing A2A Task. */
export interface PublishedA2AFile extends StoredA2AFile {
  readonly name: string
}

/** Ordered files accepted while one A2A Task owns a Session. */
export interface A2APublicationWindow extends Disposable {
  /** @returns Snapshot of published files in tool-call order. */
  files(): readonly PublishedA2AFile[]
}

/** Identity-bearing publication capability for one exact Task window. */
export interface A2APublicationTarget {
  /**
   * Append a snapshotted file only while the captured Task window remains active.
   * @param file - Immutable stored file metadata.
   */
  publish(file: PublishedA2AFile): void
}

/** Publication registry operation required by inbound execution. */
export interface A2AFilePublicationRegistry {
  open(taskId: A2ATaskId, sessionId: SessionId): A2APublicationWindow
}

/** Network and lifecycle policy for the outbound A2A client. */
export interface A2AAgentClientOptions {
  readonly maxTimeoutMs: number
  readonly maxResponseBytes: number
  readonly maxRedirects: number
  readonly cancelTimeoutMs: number
  /** File snapshot, Part projection, and result materialization service. */
  readonly fileTransfer?: {
    snapshotLocal(input: A2AOutboundFileInput, workspaceRoot: string, signal: AbortSignal): Promise<StoredA2AFile>
    toPart(file: PublishedA2AFile, taskId: A2ATaskId, signal?: AbortSignal): Promise<Part>
    materializePart(
      part: Part,
      allowedOrigin: (url: URL) => boolean,
      signal: AbortSignal,
    ): Promise<StoredA2AFile & { readonly path: string }>
  }
  /** Extra exact origins accepted for remote result file URIs. */
  readonly fileUrlAllowedOrigins?: readonly string[]
  /** Injectable transport for deterministic tests and custom runtimes. */
  readonly fetchImpl?: typeof fetch
  /** Injectable deadline allocation for deterministic lifecycle tests. */
  readonly deadlineFactory?: (timeoutMs: number) => ExecutionDeadline
}

/** Dependencies and runtime limits for inbound Session-backed execution. */
export interface DshAgentExecutorOptions {
  readonly repository: A2ARepository
  readonly scheduler: ContextScheduler
  readonly tracker: SessionTurnTracker
  readonly sessionController: Pick<SessionController, 'create' | 'prompt' | 'cancel'>
  readonly fileTransfer: A2AInboundFileTransfer
  readonly fileUrlAllowedOrigin: (url: URL) => boolean
  readonly publications: A2AFilePublicationRegistry
  readonly interactions: A2AQuestionBroker
  readonly requestTimeoutMs: number
  readonly agentPreset?: string
  /** Injectable deadline allocation for deterministic lifecycle tests. */
  readonly deadlineFactory?: (timeoutMs: number) => ExecutionDeadline
}

/** One skill declared by the configured Business Agent. */
export interface A2ASkillConfig {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags: string[]
}

/** Public identity and media declarations for the configured Business Agent. */
export interface A2AAgentConfig {
  readonly name: string
  readonly description: string
  readonly version: string
  readonly defaultInputModes: string[]
  readonly defaultOutputModes: string[]
  readonly skills: A2ASkillConfig[]
}

/** Optional private listener that exposes only the A2A application. */
export interface A2AListenerConfig {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
}

/** User-facing Cordis plugin configuration. */
export interface Config {
  readonly route?: string
  readonly listener?: A2AListenerConfig | undefined
  readonly publicBaseUrl?: string
  readonly agent: A2AAgentConfig
  readonly bearerTokenEnv?: string
  readonly requestTimeoutMs?: number
  readonly outboundTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxConcurrentContexts?: number
  readonly inlineFileMaxBytes?: number
  readonly maxFileBytes?: number
  readonly fileRetentionMs?: number
  readonly fileUrlAllowedOrigins?: string[]
  readonly publishFileAllowedRoots?: string[]
  readonly agentPreset?: string
}

/** Validated runtime configuration before the Agent Card is materialized. */
export interface ResolvedA2AConfigCore {
  readonly route: string
  readonly cardPath: '/.well-known/agent-card.json'
  readonly listener?: A2AListenerConfig
  readonly publicBaseUrl: URL
  readonly bearerToken?: string
  readonly requestTimeoutMs: number
  readonly outboundTimeoutMs: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly maxConcurrentContexts: number
  readonly inlineFileMaxBytes: number
  readonly maxFileBytes: number
  readonly fileRetentionMs: number
  readonly fileUrlAllowedOrigins: readonly string[]
  readonly publishFileAllowedRoots: readonly string[]
  readonly agentPreset?: string
  readonly agent: A2AAgentConfig
}

/** Fully validated configuration consumed by all bridge components. */
export interface ResolvedA2AConfig extends ResolvedA2AConfigCore {
  readonly agentCard: AgentCard
}

/** Web Server deployment facts required to validate public endpoint policy. */
export interface A2ADeployment {
  readonly host: string
  readonly port: number
  readonly env: NodeJS.ProcessEnv
}
