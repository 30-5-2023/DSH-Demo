import type { AgentCard, Task } from '@a2a-js/sdk'
import type {
  PromptContentPart,
  SessionController,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'

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
  getTask(taskId: A2ATaskId): Promise<Task | undefined>
  getTaskByMessageId(messageId: A2AMessageId): Promise<Task | undefined>
  saveTask(task: Task, inputMessageId?: A2AMessageId): Promise<void>
  markInterruptedTasksFailed(now: string): Promise<number>
  close(): Promise<void>
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

/** Dependencies and runtime limits for inbound Session-backed execution. */
export interface DshAgentExecutorOptions {
  readonly repository: A2ARepository
  readonly scheduler: ContextScheduler
  readonly tracker: SessionTurnTracker
  readonly sessionController: Pick<SessionController, 'create' | 'prompt' | 'cancel'>
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

/** User-facing Cordis plugin configuration. */
export interface Config {
  readonly route?: string
  readonly publicBaseUrl?: string
  readonly agent: A2AAgentConfig
  readonly bearerTokenEnv?: string
  readonly requestTimeoutMs?: number
  readonly outboundTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxConcurrentContexts?: number
  readonly agentPreset?: string
}

/** Validated runtime configuration before the Agent Card is materialized. */
export interface ResolvedA2AConfigCore {
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
