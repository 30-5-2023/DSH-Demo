import { randomUUID } from 'node:crypto'
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
  A2ATaskId,
  type A2AAgentClientOptions,
  type A2AInteractionResult,
  type A2AMaterializedFile,
  type CallA2AAgentInput,
  type CallA2AAgentResult,
  type ExecutionDeadline,
  type JsonValue,
} from './types.ts'

const SETTLED_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
])

/** Invoke remote A2A v1.0 or v0.3 JSON-RPC agents through an Agent Card URL. */
export class A2AAgentClient {
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
   * @param input - Remote invocation parameters and optional local files.
   * @param callerSignal - Tool-call cancellation signal.
   * @param workspaceRoot - Session workspace used to resolve optional local files.
   * @returns Compact identifiers, state, output or interaction, and safe failure information.
   */
  async call(
    input: CallA2AAgentInput,
    callerSignal: AbortSignal,
    workspaceRoot?: string,
  ): Promise<CallA2AAgentResult> {
    const cardUrl = validateCardUrl(input.agent_card_url)
    const timeoutMs = resolveTimeout(input.timeout_ms, this.options.maxTimeoutMs)
    const deadline = (this.options.deadlineFactory ?? createDeadline)(timeoutMs)
    const signal = AbortSignal.any([callerSignal, deadline.signal])
    let client: Client | undefined
    let taskId: string | undefined
    let cancelAttempted = false
    try {
      client = await this.createClient(cardUrl, signal, timeoutMs)
      const request = await this.createRequest(input, signal, workspaceRoot)
      if (input.stream ?? true) {
        const aggregate = createAggregate()
        for await (const response of client.sendMessageStream(request, { signal })) {
          applyStreamResponse(aggregate, response)
          taskId = aggregate.taskId
          if (isExistingInteractionSnapshot(response, input.task_id)) continue
          const responseState = streamResponseState(response)
          if (responseState !== undefined && SETTLED_STATES.has(responseState)) break
        }
        return await this.aggregateResult(aggregate, cardUrl, signal)
      }
      const result = await client.sendMessage(request, { signal })
      if (isTask(result)) taskId = result.id
      return await this.synchronousResult(result, cardUrl, signal)
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

  private async createRequest(
    input: CallA2AAgentInput,
    signal: AbortSignal,
    workspaceRoot: string | undefined,
  ): Promise<SendMessageRequest> {
    const messageId = randomUUID()
    const content = typeof input.message === 'string'
      ? { $case: 'text' as const, value: input.message }
      : { $case: 'data' as const, value: assertJsonValue(input.message) }
    const parts: Part[] = [{
      content,
      metadata: undefined,
      filename: '',
      mediaType: content.$case === 'text' ? 'text/plain' : 'application/json',
    }]
    if (input.files !== undefined && input.files.length > 0) {
      if (workspaceRoot === undefined) {
        throw new A2ABridgeError(
          'A2A_CALL_WORKSPACE_REQUIRED',
          'call_a2a_agent requires a Session workspace when files are supplied.',
        )
      }
      const transfer = this.requireFileTransfer()
      for (const file of input.files) {
        const stored = await transfer.snapshotLocal(file, workspaceRoot, signal)
        parts.push(await transfer.toPart(
          { ...stored, name: stored.ref.name },
          A2ATaskId(messageId),
          signal,
        ))
      }
    }
    return {
      tenant: '',
      message: {
        messageId,
        contextId: input.context_id ?? '',
        taskId: input.task_id ?? '',
        role: Role.ROLE_USER,
        parts,
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

  private async aggregateResult(
    aggregate: Aggregate,
    cardUrl: URL,
    signal: AbortSignal,
  ): Promise<CallA2AAgentResult> {
    const stateValue = aggregate.state ?? TaskState.TASK_STATE_UNSPECIFIED
    const groups = aggregate.artifacts.size > 0
      ? [...aggregate.artifacts.values()].map(artifact => ({ artifactId: artifact.artifactId, parts: artifact.parts }))
      : aggregate.message === undefined
        ? []
        : [{ artifactId: '', parts: aggregate.message.parts }]
    const collected = isFailedState(stateValue)
      ? {}
      : await this.collectParts(groups, cardUrl, signal, 'output')
    const interaction = stateValue === TaskState.TASK_STATE_INPUT_REQUIRED && aggregate.statusMessage !== undefined
      ? await this.collectParts([{ artifactId: '', parts: aggregate.statusMessage.parts }], cardUrl, signal, 'interaction')
      : {}
    return compactResult(
      aggregate.contextId,
      aggregate.taskId,
      taskStateName(stateValue),
      collected.output,
      interaction.interaction,
      [...(collected.files ?? []), ...(interaction.files ?? [])],
      stateValue,
    )
  }

  private async synchronousResult(
    result: SendMessageResult,
    cardUrl: URL,
    signal: AbortSignal,
  ): Promise<CallA2AAgentResult> {
    if (!isTask(result)) {
      const collected = await this.collectParts([{ artifactId: '', parts: result.parts }], cardUrl, signal, 'output')
      return compactResult(
        result.contextId || undefined,
        result.taskId || undefined,
        'MESSAGE',
        collected.output,
        undefined,
        collected.files,
      )
    }
    const stateValue = result.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED
    const collected = isFailedState(stateValue)
      ? {}
      : await this.collectParts(
          result.artifacts.map(artifact => ({ artifactId: artifact.artifactId, parts: artifact.parts })),
          cardUrl,
          signal,
          'output',
        )
    const interaction = stateValue === TaskState.TASK_STATE_INPUT_REQUIRED && result.status?.message !== undefined
      ? await this.collectParts([{ artifactId: '', parts: result.status.message.parts }], cardUrl, signal, 'interaction')
      : {}
    return compactResult(
      result.contextId,
      result.id,
      taskStateName(stateValue),
      collected.output,
      interaction.interaction,
      [...(collected.files ?? []), ...(interaction.files ?? [])],
      stateValue,
    )
  }

  private async collectParts(
    groups: readonly { readonly artifactId: string; readonly parts: readonly Part[] }[],
    cardUrl: URL,
    signal: AbortSignal,
    mode: 'output' | 'interaction',
  ): Promise<{ readonly output?: string | JsonValue; readonly interaction?: A2AInteractionResult; readonly files?: A2AMaterializedFile[] }> {
    const values: (string | JsonValue)[] = []
    const textValues: string[] = []
    const dataValues: JsonValue[] = []
    const files: A2AMaterializedFile[] = []
    const configuredOrigins = new Set(this.options.fileUrlAllowedOrigins ?? [])
    const allowedOrigin = (url: URL): boolean => url.origin === cardUrl.origin || configuredOrigins.has(url.origin)
    for (const group of groups) {
      for (const part of group.parts) {
        const content = part.content
        if (content === undefined) unsupportedPart()
        switch (content.$case) {
          case 'text':
            values.push(content.value)
            textValues.push(content.value)
            break
          case 'data': {
            const value = assertJsonValue(content.value)
            values.push(value)
            dataValues.push(value)
            break
          }
          case 'raw':
          case 'url': {
            const stored = await this.requireFileTransfer().materializePart(part, allowedOrigin, signal)
            files.push({
              path: stored.path,
              name: stored.ref.name,
              mime_type: stored.mediaType,
              bytes: stored.ref.bytes,
              artifact_id: group.artifactId,
            })
            break
          }
          default:
            assertNever(content)
        }
      }
    }
    const output = mode === 'output' ? outputFromValues(values) : undefined
    const interaction = mode === 'interaction' && (textValues.length > 0 || dataValues.length > 0)
      ? {
          ...(textValues.length === 0 ? {} : { text: textValues.join('') }),
          ...(dataValues.length === 0 ? {} : { data: dataValues }),
        }
      : undefined
    return {
      ...(output === undefined ? {} : { output }),
      ...(interaction === undefined ? {} : { interaction }),
      ...(files.length === 0 ? {} : { files }),
    }
  }

  private requireFileTransfer(): NonNullable<A2AAgentClientOptions['fileTransfer']> {
    if (this.options.fileTransfer === undefined) unsupportedPart()
    return this.options.fileTransfer
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
  statusMessage: Message | undefined
}

function createAggregate(): Aggregate {
  return { artifacts: new Map(), statusMessage: undefined }
}

function applyStreamResponse(aggregate: Aggregate, response: StreamResponse): void {
  const payload = response.payload
  if (payload === undefined) return
  switch (payload.$case) {
    case 'task':
      aggregate.contextId = payload.value.contextId
      aggregate.taskId = payload.value.id
      if (payload.value.status !== undefined) {
        aggregate.state = payload.value.status.state
        aggregate.statusMessage = payload.value.status.message
      }
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
      if (payload.value.status !== undefined) {
        aggregate.state = payload.value.status.state
        aggregate.statusMessage = payload.value.status.message
      }
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

function isExistingInteractionSnapshot(response: StreamResponse, taskId: string | undefined): boolean {
  const payload = response.payload
  return taskId !== undefined
    && payload?.$case === 'task'
    && payload.value.id === taskId
    && payload.value.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED
}

function streamResponseState(response: StreamResponse): TaskState | undefined {
  const payload = response.payload
  if (payload?.$case === 'task') return payload.value.status?.state
  if (payload?.$case === 'statusUpdate') return payload.value.status?.state
  return undefined
}

function replaceArtifacts(aggregate: Aggregate, artifacts: readonly Artifact[]): void {
  aggregate.artifacts.clear()
  for (const artifact of artifacts) aggregate.artifacts.set(artifact.artifactId, artifact)
}

function compactResult(
  contextId: string | undefined,
  taskId: string | undefined,
  state: string,
  output: string | JsonValue | undefined,
  interaction: A2AInteractionResult | undefined,
  files: A2AMaterializedFile[] | undefined,
  stateValue?: TaskState,
): CallA2AAgentResult {
  const failed = stateValue !== undefined && isFailedState(stateValue)
  return {
    ...(contextId === undefined || contextId === '' ? {} : { context_id: contextId }),
    ...(taskId === undefined || taskId === '' ? {} : { task_id: taskId }),
    state,
    ...(output === undefined || failed ? {} : { output }),
    ...(interaction === undefined || failed ? {} : { interaction }),
    ...(files === undefined || files.length === 0 || failed ? {} : { files }),
    ...(failed ? { failure: { code: 'A2A_REMOTE_FAILED', message: `Remote A2A task ended in ${state}.` } } : {}),
  }
}

function outputFromValues(values: readonly (string | JsonValue)[]): string | JsonValue | undefined {
  if (values.length === 0) return undefined
  if (values.every(value => typeof value === 'string')) return values.join('')
  return values.length === 1 ? values[0] : [...values]
}

function isFailedState(state: TaskState): boolean {
  return [
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
  ].includes(state)
}

function unsupportedPart(): never {
  throw new A2ABridgeError('A2A_UNSUPPORTED_PART', 'Remote A2A output contains an unsupported Part.')
}

function assertNever(value: never): never {
  void value
  return unsupportedPart()
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
