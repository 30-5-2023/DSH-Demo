import { randomUUID } from 'node:crypto'
import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Task,
  type TaskStatus,
} from '@a2a-js/sdk'
import { TaskNotFoundError } from '@a2a-js/sdk/errors'
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { a2aMessageToPrompt, assistantTextToArtifact, safeA2AFailure } from './conversion.ts'
import { isTerminalTask } from './store.ts'
import {
  A2AContextId,
  A2AMessageId,
  A2ATaskId,
  type A2ABridgeErrorCode,
  type DshAgentExecutorOptions,
  type ExecutionDeadline,
} from './types.ts'

interface ExecutionRecord {
  readonly taskId: A2ATaskId
  readonly contextId: A2AContextId
  readonly events: ExecutionEventBus
  readonly done: Promise<void>
  readonly finish: () => void
  task: Task
  sessionId?: SessionId
  scheduled?: Promise<void>
  cancelRequested: boolean
  cancelSent: boolean
  terminalWrite?: Promise<Task>
}

class ExecutionFailure extends Error {
  override readonly name = 'ExecutionFailure'

  constructor(
    readonly code: A2ABridgeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** Official A2A executor backed by durable Tasks and exact DSH Session turns. */
export class DshAgentExecutor implements AgentExecutor {
  private readonly executions = new Map<A2ATaskId, ExecutionRecord>()
  private readonly newContextMessages = new Set<A2AMessageId>()

  /** @param options - Durable repository, Session services, scheduler, and timeout policy. */
  constructor(private readonly options: DshAgentExecutorOptions) {}

  /**
   * Preserve that the public request omitted a context before the SDK resolves an id.
   * @param messageId - First message whose generated context may be created.
   */
  allowNewContext(messageId: string): void {
    this.newContextMessages.add(A2AMessageId(messageId))
  }

  /**
   * Execute one admitted A2A message through its context-owned Session.
   * @param request - SDK request with resolved Task and context identities.
   * @param events - SDK event sink shared by blocking and streaming requests.
   * @returns Fulfillment after one terminal Task state is committed.
   */
  async execute(request: RequestContext, events: ExecutionEventBus): Promise<void> {
    const taskId = A2ATaskId(request.taskId || randomUUID())
    const contextId = A2AContextId(request.contextId || randomUUID())
    const message = normalizedMessage(request.userMessage, taskId, contextId)
    const messageId = A2AMessageId(message.messageId)
    const priorMessageTask = await this.options.repository.getTaskByMessageId(messageId)
    if (priorMessageTask !== undefined) {
      events.publish(AgentEvent.task(priorMessageTask))
      return
    }
    const priorTask = await this.options.repository.getTask(taskId)
    if (priorTask !== undefined && isTerminalTask(priorTask)) {
      events.publish(AgentEvent.task(priorTask))
      return
    }

    const existingContext = await this.options.repository.getContext(contextId)
    const handlerAdmittedNewContext = this.newContextMessages.delete(messageId)
    const callerSuppliedContext = !handlerAdmittedNewContext && request.userMessage.contextId.trim() !== ''
    if (callerSuppliedContext && existingContext === undefined) {
      throw new TaskNotFoundError(`A2A context not found: ${contextId}`)
    }
    const prompt = a2aMessageToPrompt(message, request.request.configuration?.acceptedOutputModes)
    const submitted = taskWithStatus({
      id: taskId,
      contextId,
      status: undefined,
      artifacts: [],
      history: [message],
      metadata: undefined,
    }, TaskState.TASK_STATE_SUBMITTED)
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const record: ExecutionRecord = {
      taskId,
      contextId,
      events,
      done,
      finish,
      task: submitted,
      cancelRequested: false,
      cancelSent: false,
    }
    this.executions.set(taskId, record)

    try {
      await this.options.repository.saveTask(submitted, messageId)
      events.publish(AgentEvent.task(submitted))

      if (existingContext === undefined) {
        let created: { readonly sessionId: SessionId }
        try {
          created = await this.options.sessionController.create({
            ...(this.options.agentPreset === undefined ? {} : { agentPreset: this.options.agentPreset }),
          })
        } catch (error: unknown) {
          throw new ExecutionFailure(
            'A2A_SESSION_CREATE_FAILED',
            'The Business Agent could not create a Session.',
            { cause: error },
          )
        }
        record.sessionId = created.sessionId
        const now = new Date().toISOString()
        await this.options.repository.createContext({
          contextId,
          sessionId: created.sessionId,
          createdAt: now,
          updatedAt: now,
        })
      } else {
        record.sessionId = existingContext.sessionId
      }

      if (record.cancelRequested) {
        await this.settleCanceled(record)
        return
      }
      const working = taskWithStatus(record.task, TaskState.TASK_STATE_WORKING)
      await this.options.repository.saveTask(working, messageId)
      record.task = working
      events.publish(AgentEvent.statusUpdate(statusEvent(working)))

      const scheduled = this.options.scheduler.run(taskId, contextId, async (schedulerSignal) => {
        await this.runTurn(record, messageId, prompt, schedulerSignal)
      })
      record.scheduled = scheduled
      await scheduled
    } catch (error: unknown) {
      if (record.cancelRequested) await this.settleCanceled(record)
      else await this.settleFailed(record, error)
    } finally {
      record.finish()
      this.executions.delete(taskId)
    }
  }

  /**
   * Cancel queued or active execution without touching sibling Sessions.
   * @param taskIdValue - Task selected by the A2A CancelTask request.
   * @param events - Live Task event sink, when execution is still attached.
   * @returns Fulfillment after cancellation or an existing terminal Task is observed.
   */
  async cancelTask(taskIdValue: string, events: ExecutionEventBus): Promise<void> {
    const taskId = A2ATaskId(taskIdValue)
    const record = this.executions.get(taskId)
    if (record === undefined) {
      const task = await this.options.repository.getTask(taskId)
      if (task === undefined) throw new TaskNotFoundError(`Task not found: ${taskId}`)
      if (isTerminalTask(task)) {
        events.publish(AgentEvent.task(task))
        return
      }
      const canceled = taskWithStatus(task, TaskState.TASK_STATE_CANCELED, failureMessage(
        task,
        'A2A_TASK_CANCELED',
        'The A2A task was canceled.',
      ))
      await this.options.repository.saveTask(canceled)
      events.publish(AgentEvent.statusUpdate(statusEvent(canceled)))
      return
    }

    record.cancelRequested = true
    const phase = this.options.scheduler.cancel(taskId)
    if (phase === 'active') this.cancelSession(record)
    await record.done
  }

  private async runTurn(
    record: ExecutionRecord,
    messageId: A2AMessageId,
    prompt: ReturnType<typeof a2aMessageToPrompt>,
    schedulerSignal: AbortSignal,
  ): Promise<void> {
    const sessionId = record.sessionId
    if (sessionId === undefined) throw new Error('A2A execution reached the scheduler without a Session')
    const deadline = (this.options.deadlineFactory ?? createDeadline)(this.options.requestTimeoutMs)
    const local = new AbortController()
    const signal = AbortSignal.any([schedulerSignal, deadline.signal, local.signal])
    const tracked = this.options.tracker.track({
      sessionId,
      requestId: brandString<SessionRequestId>(`${messageId}:${record.taskId}`),
      signal,
      onTextDelta: delta => this.publishTextDelta(record, delta),
    })
    void tracked.catch(() => {})

    try {
      try {
        await this.options.sessionController.prompt({
          sessionId,
          requestId: brandString<SessionRequestId>(`${messageId}:${record.taskId}`),
          mode: 'queue',
          content: prompt.content,
        }, signal)
      } catch (error: unknown) {
        local.abort(error)
        await Promise.allSettled([tracked])
        if (deadline.signal.aborted && !schedulerSignal.aborted) {
          this.cancelSession(record)
          throw new ExecutionFailure('A2A_EXECUTION_TIMEOUT', 'The Business Agent request timed out.')
        }
        if (schedulerSignal.aborted || record.cancelRequested) throw error
        throw new ExecutionFailure(
          'A2A_SESSION_PROMPT_FAILED',
          'The Business Agent could not admit the prompt.',
          { cause: error },
        )
      }

      let result: Awaited<typeof tracked>
      try {
        result = await tracked
      } catch (error: unknown) {
        if (deadline.signal.aborted && !schedulerSignal.aborted) {
          this.cancelSession(record)
          throw new ExecutionFailure('A2A_EXECUTION_TIMEOUT', 'The Business Agent request timed out.')
        }
        throw error
      }
      signal.throwIfAborted()
      if (result.reason.kind !== 'completed') {
        throw new ExecutionFailure('A2A_TURN_FAILED', 'The Business Agent turn did not complete successfully.')
      }
      const artifact = assistantTextToArtifact(result.text, prompt.requestedMode)
      const withArtifact: Task = { ...record.task, artifacts: [artifact] }
      await this.options.repository.saveTask(withArtifact, messageId)
      record.task = withArtifact
      record.events.publish(AgentEvent.artifactUpdate(artifactEvent(record, artifact)))
      await this.settleCompleted(record)
    } finally {
      local.abort(new Error('A2A turn tracking finished'))
      deadline.close()
    }
  }

  private publishTextDelta(record: ExecutionRecord, delta: string): void {
    const artifact = assistantTextToArtifact(delta, 'text')
    record.events.publish(AgentEvent.artifactUpdate({
      ...artifactEvent(record, artifact),
      append: true,
      lastChunk: false,
    }))
  }

  private cancelSession(record: ExecutionRecord): void {
    if (record.cancelSent || record.sessionId === undefined) return
    record.cancelSent = true
    try {
      this.options.sessionController.cancel({ sessionId: record.sessionId })
    } catch (_cancelError: unknown) {
      // Task settlement remains authoritative when Session cancellation reporting fails.
    }
  }

  private settleCompleted(record: ExecutionRecord): Promise<Task> {
    return this.settleTerminal(record, TaskState.TASK_STATE_COMPLETED)
  }

  private settleCanceled(record: ExecutionRecord): Promise<Task> {
    return this.settleTerminal(
      record,
      TaskState.TASK_STATE_CANCELED,
      failureMessage(record.task, 'A2A_TASK_CANCELED', 'The A2A task was canceled.'),
    )
  }

  private settleFailed(record: ExecutionRecord, error: unknown): Promise<Task> {
    const safe = error instanceof ExecutionFailure
      ? { code: error.code, message: error.message }
      : safeA2AFailure(error, { code: 'A2A_TURN_FAILED', message: 'The Business Agent request failed.' })
    return this.settleTerminal(
      record,
      TaskState.TASK_STATE_FAILED,
      failureMessage(record.task, safe.code, safe.message),
      safe,
    )
  }

  private settleTerminal(
    record: ExecutionRecord,
    state: TaskState,
    message?: Message,
    failure?: { readonly code: string; readonly message: string },
  ): Promise<Task> {
    if (record.terminalWrite !== undefined) return record.terminalWrite
    record.terminalWrite = (async () => {
      const latest = await this.options.repository.getTask(record.taskId)
      if (latest !== undefined && isTerminalTask(latest)) {
        record.task = latest
        return latest
      }
      const terminal = taskWithStatus(record.task, state, message, failure)
      await this.options.repository.saveTask(terminal)
      record.task = terminal
      record.events.publish(AgentEvent.statusUpdate(statusEvent(terminal)))
      return terminal
    })()
    return record.terminalWrite
  }
}

function normalizedMessage(message: Message, taskId: A2ATaskId, contextId: A2AContextId): Message {
  return { ...message, taskId, contextId }
}

function taskWithStatus(
  task: Task,
  state: TaskState,
  message?: Message,
  failure?: { readonly code: string; readonly message: string },
): Task {
  return {
    ...task,
    status: { state, message, timestamp: new Date().toISOString() },
    metadata: failure === undefined ? task.metadata : { ...task.metadata, dshFailure: failure },
  }
}

function statusEvent(task: Task): {
  taskId: string
  contextId: string
  status: TaskStatus
  metadata: undefined
} {
  if (task.status === undefined) throw new Error(`A2A task ${task.id} has no status`)
  return { taskId: task.id, contextId: task.contextId, status: task.status, metadata: undefined }
}

function artifactEvent(record: ExecutionRecord, artifact: Artifact): {
  taskId: string
  contextId: string
  artifact: Artifact
  append: boolean
  lastChunk: boolean
  metadata: undefined
} {
  return {
    taskId: record.taskId,
    contextId: record.contextId,
    artifact,
    append: false,
    lastChunk: true,
    metadata: undefined,
  }
}

function failureMessage(task: Task, code: string, summary: string): Message {
  return {
    messageId: randomUUID(),
    contextId: task.contextId,
    taskId: task.id,
    role: Role.ROLE_AGENT,
    parts: [{
      content: { $case: 'text', value: `${code}: ${summary}` },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function createDeadline(timeoutMs: number): ExecutionDeadline {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`A2A request exceeded ${timeoutMs} ms`))
  }, timeoutMs)
  timer.unref()
  return { signal: controller.signal, close: () => clearTimeout(timer) }
}
