import type {
  AgentCard,
  DeleteTaskPushNotificationConfigRequest,
  GetExtendedAgentCardRequest,
  GetTaskPushNotificationConfigRequest,
  ListTaskPushNotificationConfigsRequest,
  ListTaskPushNotificationConfigsResponse,
  ListTasksRequest,
  ListTasksResponse,
  Message,
  SendMessageRequest,
  StreamResponse,
  SubscribeToTaskRequest,
  Task,
  TaskPushNotificationConfig,
} from '@a2a-js/sdk'
import { TaskState } from '@a2a-js/sdk'
import { UnsupportedOperationError } from '@a2a-js/sdk/errors'
import {
  DefaultExecutionEventBus,
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  type AgentExecutionEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type ServerCallContext,
  type TaskStore,
} from '@a2a-js/sdk/server'
import { isTerminalTask } from './store.ts'
import { A2AMessageId, A2ATaskId, type A2ARepository } from './types.ts'

interface NewContextAwareExecutor extends AgentExecutor {
  allowNewContext?(messageId: string): void
}

/** A2A request handler restricted to the bridge's approved public operations. */
export class BridgeRequestHandler extends DefaultRequestHandler {
  private readonly coordinator: MessageFlightCoordinator
  private readonly bridgeExecutor: NewContextAwareExecutor

  /**
   * @param agentCard - Public capabilities used by the official handler.
   * @param taskStore - Official SDK persistence adapter.
   * @param executor - Session-backed Task executor.
   * @param repository - Durable message-id lookup used before SDK dispatch.
   */
  constructor(
    agentCard: AgentCard,
    taskStore: TaskStore,
    executor: NewContextAwareExecutor,
    repository: A2ARepository,
  ) {
    const coordinator = new MessageFlightCoordinator(repository)
    super(agentCard, taskStore, coordinator.observe(executor), new RequestEventBusManager())
    this.coordinator = coordinator
    this.bridgeExecutor = executor
  }

  /**
   * Execute or join one blocking request by its caller-provided message id.
   * @param params - A2A send request.
   * @param context - Authenticated server call context.
   * @returns The first execution's final Task, or a stand-alone Message from the SDK.
   */
  override async sendMessage(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<Message | Task> {
    const messageId = requestMessageId(params)
    if (messageId === undefined) return super.sendMessage(params, context)
    const duplicate = await this.coordinator.duplicate(messageId)
    if (duplicate !== undefined) return duplicate

    const flight = this.coordinator.start(messageId)
    this.admitNewContext(params)
    try {
      return await super.sendMessage(params, context)
    } catch (error: unknown) {
      this.coordinator.fail(messageId, flight, error)
      throw error
    }
  }

  /**
   * Execute or join one streaming request by its caller-provided message id.
   * @param params - A2A streaming send request.
   * @param context - Authenticated server call context.
   * @yields Original live events, or one durable Task for a duplicate.
   */
  override async *sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const messageId = requestMessageId(params)
    if (messageId === undefined) {
      yield* super.sendMessageStream(params, context)
      return
    }
    const duplicate = await this.coordinator.duplicate(messageId)
    if (duplicate !== undefined) {
      yield taskResponse(duplicate)
      return
    }

    const flight = this.coordinator.start(messageId)
    this.admitNewContext(params)
    try {
      for await (const response of super.sendMessageStream(params, context)) yield response
    } catch (error: unknown) {
      this.coordinator.fail(messageId, flight, error)
      throw error
    }
  }

  /**
   * @param _params - Ignored list request.
   * @param _context - Authenticated server call context.
   * @returns Rejection because Task listing is outside the bridge operation allowlist.
   */
  override async listTasks(_params: ListTasksRequest, _context: ServerCallContext): Promise<ListTasksResponse> {
    throw unsupported('Task listing')
  }

  /**
   * @param _params - Ignored extended Card request.
   * @param _context - Authenticated server call context.
   * @returns Rejection because authenticated extended Cards are not advertised.
   */
  override async getAuthenticatedExtendedAgentCard(
    _params: GetExtendedAgentCardRequest,
    _context: ServerCallContext,
  ): Promise<AgentCard> {
    throw unsupported('Extended Agent Cards')
  }

  /**
   * @param _params - Ignored push configuration.
   * @param _context - Authenticated server call context.
   * @returns Rejection because push notification configuration is outside the allowlist.
   */
  override async createTaskPushNotificationConfig(
    _params: TaskPushNotificationConfig,
    _context: ServerCallContext,
  ): Promise<TaskPushNotificationConfig> {
    throw unsupported('Task push notifications')
  }

  /**
   * @param _params - Ignored push configuration lookup.
   * @param _context - Authenticated server call context.
   * @returns Rejection because push notification configuration is outside the allowlist.
   */
  override async getTaskPushNotificationConfig(
    _params: GetTaskPushNotificationConfigRequest,
    _context: ServerCallContext,
  ): Promise<TaskPushNotificationConfig> {
    throw unsupported('Task push notifications')
  }

  /**
   * @param _params - Ignored push configuration list request.
   * @param _context - Authenticated server call context.
   * @returns Rejection because push notification configuration is outside the allowlist.
   */
  override async listTaskPushNotificationConfigs(
    _params: ListTaskPushNotificationConfigsRequest,
    _context: ServerCallContext,
  ): Promise<ListTaskPushNotificationConfigsResponse> {
    throw unsupported('Task push notifications')
  }

  /**
   * @param _params - Ignored push configuration deletion.
   * @param _context - Authenticated server call context.
   * @returns Rejection because push notification configuration is outside the allowlist.
   */
  override async deleteTaskPushNotificationConfig(
    _params: DeleteTaskPushNotificationConfigRequest,
    _context: ServerCallContext,
  ): Promise<void> {
    throw unsupported('Task push notifications')
  }

  /**
   * @param _params - Ignored resubscription request.
   * @param _context - Authenticated server call context.
   * @yields Nothing because Task stream resubscription is outside the allowlist.
   */
  override async *resubscribe(
    _params: SubscribeToTaskRequest,
    _context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    throw unsupported('Task stream resubscription')
  }

  private admitNewContext(params: SendMessageRequest): void {
    const message = params.message
    if (message !== undefined && message.taskId.trim() === '' && message.contextId.trim() === '') {
      this.bridgeExecutor.allowNewContext?.(message.messageId)
    }
  }
}

/** Each request receives its initial Task privately; status and artifact updates remain Task-wide. */
class RequestEventBus extends DefaultExecutionEventBus {
  private initialized = false
  private readonly pending: AgentExecutionEvent[] = []
  private readonly relay = (event: AgentExecutionEvent): void => {
    if (this.initialized) super.publish(event)
    else this.pending.push(event)
  }
  private finishPending = false
  private readonly stop = (): void => {
    if (this.initialized) this.finished()
    else this.finishPending = true
  }

  constructor(private readonly shared: ExecutionEventBus) {
    super()
    shared.on('event', this.relay)
    shared.on('finished', this.stop)
  }

  override publish(event: AgentExecutionEvent): void {
    if (event.kind === 'task' || event.kind === 'message') {
      super.publish(event)
      this.initialized = true
      for (const queued of this.pending.splice(0)) super.publish(queued)
      if (this.finishPending) this.finished()
    } else this.shared.publish(event)
  }

  override finished(): void {
    this.shared.off('event', this.relay)
    this.shared.off('finished', this.stop)
    this.pending.length = 0
    super.finished()
  }
}

class RequestEventBusManager extends DefaultExecutionEventBusManager {
  override createOrGetByTaskId(taskId: string, context?: ServerCallContext): ExecutionEventBus {
    return new RequestEventBus(super.createOrGetByTaskId(taskId, context))
  }

  settleByTaskId(
    taskId: string,
    events: ExecutionEventBus,
    lastState: TaskState | undefined,
    context: ServerCallContext,
  ): boolean {
    events.finished()
    if (lastState !== undefined && [
      TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED,
      TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED,
    ].includes(lastState)) {
      this.getByTaskId(taskId, context)?.finished()
      this.cleanupByTaskId(taskId, context)
    }
    return true
  }
}

interface MessageFlight {
  readonly promise: Promise<Task>
  readonly resolve: (task: Task) => void
  readonly reject: (error: unknown) => void
}

class MessageFlightCoordinator {
  private readonly flights = new Map<A2AMessageId, MessageFlight>()

  constructor(private readonly repository: A2ARepository) {}

  observe(executor: AgentExecutor): AgentExecutor {
    return {
      execute: async (request, events) => {
        const messageId = A2AMessageId(request.userMessage.messageId)
        try {
          await executor.execute(request, events)
          await this.complete(messageId, A2ATaskId(request.taskId))
        } catch (error: unknown) {
          const flight = this.flights.get(messageId)
          if (flight !== undefined) this.fail(messageId, flight.promise, error)
          throw error
        }
      },
      cancelTask: (taskId, events) => executor.cancelTask(taskId, events),
    }
  }

  async duplicate(messageId: A2AMessageId): Promise<Task | undefined> {
    const durable = await this.repository.getTaskByMessageId(messageId)
    const flight = this.flights.get(messageId)
    if (durable !== undefined && (isTerminalTask(durable) || durable.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED)) return durable
    if (flight !== undefined) return flight.promise
    return durable
  }

  start(messageId: A2AMessageId): Promise<Task> {
    let resolve!: (task: Task) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<Task>((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    void promise.catch(() => {})
    this.flights.set(messageId, { promise, resolve, reject })
    return promise
  }

  fail(messageId: A2AMessageId, promise: Promise<Task>, error: unknown): void {
    const flight = this.flights.get(messageId)
    if (flight === undefined || flight.promise !== promise) return
    this.flights.delete(messageId)
    flight.reject(error)
  }

  private async complete(messageId: A2AMessageId, taskId: A2ATaskId): Promise<void> {
    const flight = this.flights.get(messageId)
    if (flight === undefined) return
    const task = await this.repository.getTask(taskId)
    if (task === undefined) {
      this.fail(messageId, flight.promise, new Error(`A2A execution for message ${messageId} produced no Task`))
      return
    }
    this.flights.delete(messageId)
    flight.resolve(task)
  }
}

function requestMessageId(params: SendMessageRequest): A2AMessageId | undefined {
  const value = params.message?.messageId
  return value === undefined || value.trim() === '' ? undefined : A2AMessageId(value)
}

function taskResponse(task: Task): StreamResponse {
  return { payload: { $case: 'task', value: task } }
}

function unsupported(operation: string): UnsupportedOperationError {
  return new UnsupportedOperationError(`${operation} is not supported by this A2A bridge`)
}
