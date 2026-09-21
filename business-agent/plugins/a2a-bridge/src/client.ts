import {
  Role,
  TaskState,
  taskStateToJSON,
  type Artifact,
  type Message,
  type Part,
  type SendMessageRequest,
  type SendMessageResult,
  type StreamResponse,
  type Task,
} from '@a2a-js/sdk'
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  type Client,
} from '@a2a-js/sdk/client'
import { createBoundedFetch, createStreamingBoundedFetch } from './safe-fetch.ts'
import {
  A2ABridgeError,
  type A2AAgentClientOptions,
  type CallA2AAgentInput,
  type CallA2AAgentResult,
  type ExecutionDeadline,
  type JsonValue,
} from './types.ts'

const TERMINAL_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
])

/** Invoke remote A2A v1.0 or v0.3 JSON-RPC agents through an Agent Card URL. */
export class A2AAgentClient {
  private messageSequence = 0

  constructor(private readonly options: A2AAgentClientOptions) {
    assertPositiveInteger(options.maxTimeoutMs, 'maxTimeoutMs')
    assertPositiveInteger(options.maxResponseBytes, 'maxResponseBytes')
    assertPositiveInteger(options.cancelTimeoutMs, 'cancelTimeoutMs')
    if (!Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0) {
      throw new TypeError('business-a2a-bridge: maxRedirects must be a non-negative integer')
    }
  }

  /**
   * Fetch a fresh Agent Card and run one remote message.
   * @param input - URL-only remote invocation parameters.
   * @param callerSignal - Tool-call cancellation signal.
   * @returns Compact identifiers, state, output, and safe failure information.
   */
  async call(input: CallA2AAgentInput, callerSignal: AbortSignal): Promise<CallA2AAgentResult> {
    const cardUrl = validateCardUrl(input.agent_card_url)
    const timeoutMs = resolveTimeout(input.timeout_ms, this.options.maxTimeoutMs)
    const deadline = (this.options.deadlineFactory ?? createDeadline)(timeoutMs)
    const signal = AbortSignal.any([callerSignal, deadline.signal])
    let client: Client | undefined
    let taskId: string | undefined
    let cancelAttempted = false
    try {
      client = await this.createClient(cardUrl, signal, timeoutMs)
      const request = this.createRequest(input)
      if (input.stream ?? true) {
        const aggregate = createAggregate()
        for await (const response of client.sendMessageStream(request, { signal })) {
          applyStreamResponse(aggregate, response)
          taskId = aggregate.taskId
          if (aggregate.state !== undefined && TERMINAL_STATES.has(aggregate.state)) break
        }
        return aggregateResult(aggregate)
      }
      const result = await client.sendMessage(request, { signal })
      if (isTask(result)) taskId = result.id
      return synchronousResult(result)
    } catch (error: unknown) {
      if (client !== undefined && taskId !== undefined && (callerSignal.aborted || deadline.signal.aborted)) {
        cancelAttempted = true
        await this.cancelRemote(client, taskId)
      }
      if (deadline.signal.aborted && !callerSignal.aborted) {
        throw new A2ABridgeError('A2A_FETCH_TIMEOUT', 'Remote A2A request timed out.', { cause: error })
      }
      if (callerSignal.aborted) {
        throw new A2ABridgeError('A2A_FETCH_ABORTED', 'Remote A2A request was canceled.', { cause: error })
      }
      throw error
    } finally {
      if (!cancelAttempted && client !== undefined && taskId !== undefined && (callerSignal.aborted || deadline.signal.aborted)) {
        await this.cancelRemote(client, taskId)
      }
      deadline.close()
    }
  }

  private async createClient(cardUrl: URL, signal: AbortSignal, timeoutMs: number): Promise<Client> {
    const fetchImpl = this.options.fetchImpl
    const common = {
      timeoutMs,
      maxResponseBytes: this.options.maxResponseBytes,
      maxRedirects: this.options.maxRedirects,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    }
    const cardResolver = new DefaultAgentCardResolver({
      fetchImpl: createBoundedFetch({ ...common, signal }),
      legacyCompat: { enabled: true },
    })
    const transport = new JsonRpcTransportFactory({
      fetchImpl: createStreamingBoundedFetch(common),
      legacyCompat: { enabled: true },
    })
    const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver,
      transports: [transport],
    }))
    return await factory.createFromUrl(cardUrl.href, '')
  }

  private createRequest(input: CallA2AAgentInput): SendMessageRequest {
    const messageId = `a2a-outbound-${++this.messageSequence}`
    const content = typeof input.message === 'string'
      ? { $case: 'text' as const, value: input.message }
      : { $case: 'data' as const, value: assertJsonValue(input.message) }
    return {
      tenant: '',
      message: {
        messageId,
        contextId: input.context_id ?? '',
        taskId: '',
        role: Role.ROLE_USER,
        parts: [{ content, metadata: undefined, filename: '', mediaType: content.$case === 'text' ? 'text/plain' : 'application/json' }],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: {
        acceptedOutputModes: [input.accepted_output_mode === 'json' ? 'application/json' : 'text/plain'],
        taskPushNotificationConfig: undefined,
        returnImmediately: false,
      },
      metadata: undefined,
    }
  }

  private async cancelRemote(client: Client, taskId: string): Promise<void> {
    const deadline = createDeadline(this.options.cancelTimeoutMs)
    try {
      await client.cancelTask({ tenant: '', id: taskId, metadata: undefined }, { signal: deadline.signal })
    } catch (_cancelError: unknown) {
      // Local cancellation already owns the result; cleanup remains best-effort and bounded.
    } finally {
      deadline.close()
    }
  }
}

interface Aggregate {
  contextId?: string
  taskId?: string
  state?: TaskState
  readonly artifacts: Map<string, Artifact>
  message?: Message
}

function createAggregate(): Aggregate {
  return { artifacts: new Map() }
}

function applyStreamResponse(aggregate: Aggregate, response: StreamResponse): void {
  const payload = response.payload
  if (payload === undefined) return
  switch (payload.$case) {
    case 'task':
      aggregate.contextId = payload.value.contextId
      aggregate.taskId = payload.value.id
      if (payload.value.status !== undefined) aggregate.state = payload.value.status.state
      replaceArtifacts(aggregate, payload.value.artifacts)
      return
    case 'message':
      if (payload.value.contextId !== '') aggregate.contextId = payload.value.contextId
      if (payload.value.taskId !== '') aggregate.taskId = payload.value.taskId
      aggregate.message = payload.value
      return
    case 'statusUpdate':
      aggregate.contextId = payload.value.contextId
      aggregate.taskId = payload.value.taskId
      if (payload.value.status !== undefined) aggregate.state = payload.value.status.state
      return
    case 'artifactUpdate': {
      aggregate.contextId = payload.value.contextId
      aggregate.taskId = payload.value.taskId
      const artifact = payload.value.artifact
      if (artifact === undefined) return
      const prior = aggregate.artifacts.get(artifact.artifactId)
      aggregate.artifacts.set(artifact.artifactId, payload.value.append && prior !== undefined
        ? { ...artifact, parts: [...prior.parts, ...artifact.parts] }
        : artifact)
      return
    }
  }
}

function replaceArtifacts(aggregate: Aggregate, artifacts: readonly Artifact[]): void {
  aggregate.artifacts.clear()
  for (const artifact of artifacts) aggregate.artifacts.set(artifact.artifactId, artifact)
}

function aggregateResult(aggregate: Aggregate): CallA2AAgentResult {
  const state = taskStateName(aggregate.state ?? TaskState.TASK_STATE_UNSPECIFIED)
  const output = outputFromParts(
    aggregate.artifacts.size > 0
      ? [...aggregate.artifacts.values()].flatMap(artifact => artifact.parts)
      : aggregate.message?.parts ?? [],
  )
  return compactResult(aggregate.contextId, aggregate.taskId, state, output, aggregate.state)
}

function synchronousResult(result: SendMessageResult): CallA2AAgentResult {
  if (!isTask(result)) {
    return compactResult(
      result.contextId || undefined,
      result.taskId || undefined,
      'MESSAGE',
      outputFromParts(result.parts),
    )
  }
  const stateValue = result.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED
  return compactResult(
    result.contextId,
    result.id,
    taskStateName(stateValue),
    outputFromParts(result.artifacts.flatMap(artifact => artifact.parts)),
    stateValue,
  )
}

function compactResult(
  contextId: string | undefined,
  taskId: string | undefined,
  state: string,
  output: string | JsonValue | undefined,
  stateValue?: TaskState,
): CallA2AAgentResult {
  const failed = stateValue !== undefined && [
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
  ].includes(stateValue)
  return {
    ...(contextId === undefined || contextId === '' ? {} : { context_id: contextId }),
    ...(taskId === undefined || taskId === '' ? {} : { task_id: taskId }),
    state,
    ...(output === undefined || failed ? {} : { output }),
    ...(failed ? { failure: { code: 'A2A_REMOTE_FAILED', message: `Remote A2A task ended in ${state}.` } } : {}),
  }
}

function outputFromParts(parts: readonly Part[]): string | JsonValue | undefined {
  const values: (string | JsonValue)[] = []
  for (const part of parts) {
    if (part.content?.$case === 'text') values.push(part.content.value)
    else if (part.content?.$case === 'data') values.push(assertJsonValue(part.content.value))
  }
  if (values.length === 0) return undefined
  if (values.every(value => typeof value === 'string')) return values.join('')
  return values.length === 1 ? values[0] : values
}

function isTask(result: SendMessageResult): result is Task {
  return 'status' in result
}

function taskStateName(state: TaskState): string {
  return taskStateToJSON(state)
}

function validateCardUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch (error) {
    throw new A2ABridgeError('A2A_FETCH_URL_REJECTED', 'Remote A2A Agent Card URL must be absolute HTTP(S).', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new A2ABridgeError('A2A_FETCH_URL_REJECTED', 'Remote A2A Agent Card URL must use HTTP or HTTPS.')
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new A2ABridgeError('A2A_FETCH_URL_REJECTED', 'Remote A2A Agent Card URL must not contain credentials or a fragment.')
  }
  return url
}

function resolveTimeout(value: number | undefined, maximum: number): number {
  const timeout = value ?? maximum
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > maximum) {
    throw new TypeError(`business-a2a-bridge: timeout_ms must be an integer between 1 and ${maximum}`)
  }
  return timeout
}

function createDeadline(timeoutMs: number): ExecutionDeadline {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('deadline expired')), timeoutMs)
  timer.unref()
  return { signal: controller.signal, close: () => clearTimeout(timer) }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`business-a2a-bridge: ${field} must be a positive integer`)
  }
}

function assertJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    throw new TypeError('business-a2a-bridge: JSON values must contain finite numbers')
  }
  if (typeof value !== 'object') throw new TypeError('business-a2a-bridge: message must be a JSON value')
  if (seen.has(value)) throw new TypeError('business-a2a-bridge: message must not be cyclic')
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => assertJsonValue(item, seen))
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('business-a2a-bridge: message must use plain JSON objects')
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, assertJsonValue(item, seen)]))
  } finally {
    seen.delete(value)
  }
}
