import { Role, Task, TaskState, type ListTasksRequest, type ListTasksResponse } from '@a2a-js/sdk'
import { UnsupportedOperationError } from '@a2a-js/sdk/errors'
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  defineDomain,
  domainTable,
  type Domain,
  type DomainFacility,
} from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import {
  A2AContextId,
  A2AMessageId,
  A2ATaskId,
  type A2AContextRecord,
  type A2ARepository,
} from './types.ts'

interface StoredContextRecord {
  readonly contextId: string
  readonly sessionId: string
  readonly createdAt: string
  readonly updatedAt: string
}

interface StoredTaskRecord {
  readonly taskId: string
  readonly contextId: string
  readonly inputMessageId?: string | undefined
  readonly state: TaskState
  readonly createdAt: string
  readonly updatedAt: string
  readonly task: Record<string, unknown>
}

const contextRecordSchema: z.ZodType<StoredContextRecord> = z.object({
  contextId: z.string().min(1),
  sessionId: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

const taskRecordSchema: z.ZodType<StoredTaskRecord> = z.object({
  taskId: z.string().min(1),
  contextId: z.string().min(1),
  inputMessageId: z.string().min(1).optional(),
  state: z.nativeEnum(TaskState),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  task: z.record(z.string(), z.unknown()),
})

/** Versioned durable records owned by the A2A bridge. */
export const a2aBridgeDomain = defineDomain({
  name: 'a2a_bridge',
  version: 1,
  tables: {
    contexts: domainTable<A2AContextId, StoredContextRecord>(contextRecordSchema),
    tasks: domainTable<A2ATaskId, StoredTaskRecord>(taskRecordSchema),
  },
})

const TERMINAL_STATES = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
])

/**
 * Test whether a Task has reached an immutable terminal state.
 * @param task - Task whose current state is inspected.
 * @returns True for completed, failed, canceled, or rejected Tasks.
 */
export function isTerminalTask(task: Task): boolean {
  const state = task.status?.state
  return state !== undefined && TERMINAL_STATES.has(state)
}

const TRANSITIONS = new Map<TaskState, ReadonlySet<TaskState>>([
  [TaskState.TASK_STATE_SUBMITTED, new Set([
    TaskState.TASK_STATE_WORKING,
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
    TaskState.TASK_STATE_INPUT_REQUIRED,
    TaskState.TASK_STATE_AUTH_REQUIRED,
  ])],
  [TaskState.TASK_STATE_WORKING, new Set([
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
    TaskState.TASK_STATE_INPUT_REQUIRED,
    TaskState.TASK_STATE_AUTH_REQUIRED,
  ])],
  [TaskState.TASK_STATE_INPUT_REQUIRED, new Set([
    TaskState.TASK_STATE_WORKING,
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
  ])],
  [TaskState.TASK_STATE_AUTH_REQUIRED, new Set([
    TaskState.TASK_STATE_WORKING,
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
  ])],
])

class Mutex {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }
}

/** Storage-domain implementation of the bridge repository. */
export class StorageDomainA2ARepository implements A2ARepository {
  private readonly mutex = new Mutex()
  private closed = false

  private constructor(private readonly domain: Domain<typeof a2aBridgeDomain>) {}

  /** Open the bridge's version-1 storage domain through the configured backend. */
  static async open(facility: DomainFacility): Promise<StorageDomainA2ARepository> {
    return new StorageDomainA2ARepository(await facility.open(a2aBridgeDomain))
  }

  async getContext(contextId: A2AContextId): Promise<A2AContextRecord | undefined> {
    return this.mutex.run(() => {
      this.assertOpen()
      const record = this.domain.table('contexts').get(contextId)
      return record === undefined ? undefined : decodeContext(record)
    })
  }

  async createContext(record: A2AContextRecord): Promise<void> {
    await this.mutex.run(async () => {
      this.assertOpen()
      const contexts = this.domain.table('contexts')
      if (contexts.get(record.contextId) !== undefined) {
        throw new Error(`business-a2a-bridge: context ${record.contextId} already exists`)
      }
      await contexts.put(record.contextId, {
        contextId: record.contextId,
        sessionId: record.sessionId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
    })
  }

  async getTask(taskId: A2ATaskId, observe?: (task: Task) => void): Promise<Task | undefined> {
    return this.mutex.run(() => {
      this.assertOpen()
      const record = this.domain.table('tasks').get(taskId)
      const task = record === undefined ? undefined : decodeTask(record)
      if (task !== undefined) observe?.(task)
      return task
    })
  }

  async getTaskByMessageId(messageId: A2AMessageId): Promise<Task | undefined> {
    return this.mutex.run(() => {
      this.assertOpen()
      for (const [, record] of this.domain.table('tasks').entries()) {
        if (record.inputMessageId === messageId) return decodeTask(record)
      }
      return undefined
    })
  }

  async saveTask(task: Task, inputMessageId?: A2AMessageId): Promise<void> {
    await this.mutex.run(() => this.writeTask(task, inputMessageId))
  }

  async updateTask(
    taskId: A2ATaskId,
    update: (task: Task | undefined) => Task,
    onWriteStart?: () => void,
  ): Promise<Task> {
    return this.mutex.run(async () => {
      this.assertOpen()
      if (onWriteStart !== undefined) {
        let selected: Task | undefined
        await this.domain.table('tasks').update(taskId, existing => {
          const current = decodeTask(existing)
          const next = update(current)
          if (next.id !== taskId) throw new Error('business-a2a-bridge: Task mutation cannot change identity')
          const record = this.encodeTaskRecord(
            next,
            existing.inputMessageId === undefined ? undefined : A2AMessageId(existing.inputMessageId),
            existing,
          )
          selected = next
          onWriteStart()
          return record
        })
        if (selected === undefined) throw new Error(`business-a2a-bridge: Task ${taskId} update did not run`)
        return selected
      }
      const record = this.domain.table('tasks').get(taskId)
      const current = record === undefined ? undefined : decodeTask(record)
      const next = update(current)
      if (next.id !== taskId) throw new Error('business-a2a-bridge: Task mutation cannot change identity')
      if (next !== current) await this.writeTask(next)
      return next
    })
  }

  private async writeTask(
    task: Task,
    inputMessageId?: A2AMessageId,
  ): Promise<void> {
    this.assertOpen()
    const taskId = A2ATaskId(requiredId(task.id, 'task.id'))
    const tasks = this.domain.table('tasks')
    const existing = tasks.get(taskId)
    const resolvedMessageId = inputMessageId ?? (existing?.inputMessageId === undefined
      ? undefined
      : A2AMessageId(existing.inputMessageId))

    if (inputMessageId !== undefined) {
      for (const [otherTaskId, record] of tasks.entries()) {
        if (otherTaskId !== taskId && record.inputMessageId === inputMessageId) {
          throw new Error(`business-a2a-bridge: message ${inputMessageId} already belongs to task ${otherTaskId}`)
        }
      }
    }

    await tasks.put(taskId, this.encodeTaskRecord(task, resolvedMessageId, existing))
  }

  private encodeTaskRecord(
    task: Task,
    resolvedMessageId: A2AMessageId | undefined,
    existing: StoredTaskRecord | undefined,
  ): StoredTaskRecord {
    const taskId = A2ATaskId(requiredId(task.id, 'task.id'))
    const contextId = A2AContextId(requiredId(task.contextId, 'task.contextId'))
    const state = taskState(task)
    if (existing !== undefined) {
      if (existing.contextId !== contextId) {
        throw new Error(`business-a2a-bridge: task ${taskId} cannot change context`)
      }
      if (existing.inputMessageId !== undefined
        && resolvedMessageId !== undefined
        && existing.inputMessageId !== resolvedMessageId) {
        throw new Error(`business-a2a-bridge: task ${taskId} cannot change input message`)
      }
      validateTransition(existing, task, state)
    }

    const now = task.status?.timestamp ?? new Date().toISOString()
    const encoded = Task.toJSON(task)
    if (!isJsonObject(encoded)) {
      throw new Error(`business-a2a-bridge: task ${taskId} did not serialize to an object`)
    }
    return {
      taskId,
      contextId,
      ...(resolvedMessageId === undefined ? {} : { inputMessageId: resolvedMessageId }),
      state,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      task: encoded,
    }
  }

  async markInterruptedTasksFailed(now: string): Promise<number> {
    return this.mutex.run(async () => {
      this.assertOpen()
      const tasks = this.domain.table('tasks')
      let changed = 0
      for (const [taskId, record] of tasks.entries()) {
        if (record.state !== TaskState.TASK_STATE_SUBMITTED
          && record.state !== TaskState.TASK_STATE_WORKING
          && record.state !== TaskState.TASK_STATE_INPUT_REQUIRED) continue
        const task = decodeTask(record)
        const failed: Task = {
          ...task,
          status: {
            state: TaskState.TASK_STATE_FAILED,
            timestamp: now,
            message: {
              messageId: `${task.id}-host-interrupted`,
              contextId: task.contextId,
              taskId: task.id,
              role: Role.ROLE_AGENT,
              parts: [{
                content: { $case: 'text', value: 'A2A_HOST_INTERRUPTED: Host restarted while the task was active.' },
                metadata: undefined,
                filename: '',
                mediaType: 'text/plain',
              }],
              metadata: undefined,
              extensions: [],
              referenceTaskIds: [],
            },
          },
          metadata: {
            ...task.metadata,
            dshFailure: { code: 'A2A_HOST_INTERRUPTED', message: 'Host restarted while the task was active.' },
          },
        }
        const encoded = Task.toJSON(failed)
        if (!isJsonObject(encoded)) throw new Error(`business-a2a-bridge: task ${taskId} did not serialize to an object`)
        await tasks.put(taskId, { ...record, state: TaskState.TASK_STATE_FAILED, updatedAt: now, task: encoded })
        changed += 1
      }
      return changed
    })
  }

  async close(): Promise<void> {
    await this.mutex.run(async () => {
      if (this.closed) return
      this.closed = true
      await this.domain.close()
    })
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('business-a2a-bridge: repository is closed')
  }
}

/** Official SDK TaskStore backed by the bridge repository. */
export class DomainTaskStore implements TaskStore {
  constructor(private readonly repository: A2ARepository) {}

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    await this.repository.updateTask(A2ATaskId(task.id), existing => {
      if (existing === undefined) return task
      if (isTerminalTask(existing)) return existing
      // The executor persists status and artifacts before publishing. SDK projections only add caller history.
      const added = task.history.filter(message => message.role === Role.ROLE_USER
        && !existing.history.some(previous => previous.messageId === message.messageId))
      return added.length === 0 ? existing : { ...existing, history: [...existing.history, ...added] }
    })
  }

  load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    return this.repository.getTask(A2ATaskId(taskId))
  }

  async list(_params: ListTasksRequest, _context?: ServerCallContext): Promise<ListTasksResponse> {
    throw new UnsupportedOperationError('A2A task listing is not supported')
  }
}

function decodeContext(record: StoredContextRecord): A2AContextRecord {
  return {
    contextId: A2AContextId(record.contextId),
    sessionId: SessionId(record.sessionId),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function decodeTask(record: StoredTaskRecord): Task {
  const task = Task.fromJSON(record.task)
  if (task.id !== record.taskId || task.contextId !== record.contextId || taskState(task) !== record.state) {
    throw new Error(`business-a2a-bridge: stored task ${record.taskId} metadata does not match its payload`)
  }
  return task
}

function taskState(task: Task): TaskState {
  const state = task.status?.state
  if (state === undefined || state === TaskState.TASK_STATE_UNSPECIFIED || state === TaskState.UNRECOGNIZED) {
    throw new Error(`business-a2a-bridge: task ${task.id || '<missing>'} requires a recognized state`)
  }
  return state
}

function validateTransition(existing: StoredTaskRecord, nextTask: Task, nextState: TaskState): void {
  const previousTask = decodeTask(existing)
  if (TERMINAL_STATES.has(existing.state)) {
    if (JSON.stringify(Task.toJSON(previousTask)) !== JSON.stringify(Task.toJSON(nextTask))) {
      throw new Error(`business-a2a-bridge: terminal task ${existing.taskId} cannot be rewritten`)
    }
    return
  }
  if (nextState === existing.state) return
  if (!TRANSITIONS.get(existing.state)?.has(nextState)) {
    throw new Error(`business-a2a-bridge: illegal task transition ${existing.state} -> ${nextState}`)
  }
}

function requiredId(value: string, field: string): string {
  if (value.trim() === '') throw new Error(`business-a2a-bridge: ${field} must not be empty`)
  return value
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
