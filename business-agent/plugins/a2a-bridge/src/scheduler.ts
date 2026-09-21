import type { A2AContextId, A2ATaskId, ContextScheduler } from './types.ts'

type EntryPhase = 'queued' | 'active' | 'settled'

interface ScheduledEntry {
  readonly taskId: A2ATaskId
  readonly contextId: A2AContextId
  readonly controller: AbortController
  readonly operation: (signal: AbortSignal) => Promise<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly settled: Promise<void>
  readonly settle: () => void
  phase: EntryPhase
}

function taskCanceled(taskId: A2ATaskId): Error {
  return new Error(`A2A task ${taskId} was canceled`)
}

function schedulerClosed(): Error {
  return new Error('A2A context scheduler closed')
}

/** FIFO execution within a context with bounded concurrency across contexts. */
export class BoundedContextScheduler implements ContextScheduler {
  private readonly queues = new Map<A2AContextId, ScheduledEntry[]>()
  private readonly entries = new Map<A2ATaskId, ScheduledEntry>()
  private readonly activeContexts = new Set<A2AContextId>()
  private readonly readyContexts: A2AContextId[] = []
  private readonly readySet = new Set<A2AContextId>()
  private readonly active = new Set<ScheduledEntry>()
  private closed = false
  private closing?: Promise<void>

  /** @param maxConcurrentContexts - Maximum number of contexts executing at once. */
  constructor(private readonly maxConcurrentContexts: number) {
    if (!Number.isSafeInteger(maxConcurrentContexts) || maxConcurrentContexts < 1) {
      throw new RangeError('maxConcurrentContexts must be a positive safe integer')
    }
  }

  /**
   * Admit one operation behind earlier work in the same context.
   * @param taskId - Unique task identity used for cancellation.
   * @param contextId - Context whose operations execute serially.
   * @param operation - Abort-aware work started after admission.
   * @returns The operation's eventual result.
   */
  run<T>(
    taskId: A2ATaskId,
    contextId: A2AContextId,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) return Promise.reject(schedulerClosed())
    if (this.entries.has(taskId)) return Promise.reject(new Error(`A2A task ${taskId} is already scheduled`))

    return new Promise<T>((resolve, reject) => {
      let settle!: () => void
      const settled = new Promise<void>((done) => { settle = done })
      const entry: ScheduledEntry = {
        taskId,
        contextId,
        controller: new AbortController(),
        operation,
        resolve: value => resolve(value as T),
        reject,
        settled,
        settle,
        phase: 'queued',
      }
      const queue = this.queues.get(contextId) ?? []
      queue.push(entry)
      this.queues.set(contextId, queue)
      this.entries.set(taskId, entry)
      if (!this.activeContexts.has(contextId)) this.markReady(contextId)
      this.pump()
    })
  }

  /**
   * Cancel one queued or active task without affecting sibling contexts.
   * @param taskId - Task to remove or abort.
   * @returns The task's phase when cancellation was requested.
   */
  cancel(taskId: A2ATaskId): 'queued' | 'active' | 'missing' {
    const entry = this.entries.get(taskId)
    if (entry === undefined || entry.phase === 'settled') return 'missing'
    const error = taskCanceled(taskId)
    if (entry.phase === 'active') {
      entry.controller.abort(error)
      return 'active'
    }
    this.removeQueued(entry, error)
    this.pump()
    return 'queued'
  }

  /** @returns Fulfillment after queued work is rejected and active work settles. */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closed = true
    const error = schedulerClosed()
    for (const entry of [...this.entries.values()]) {
      if (entry.phase === 'queued') this.removeQueued(entry, error)
      else if (entry.phase === 'active') entry.controller.abort(error)
    }
    const activeSettlements = [...this.active].map(entry => entry.settled)
    this.closing = Promise.allSettled(activeSettlements).then(() => undefined)
    return this.closing
  }

  private markReady(contextId: A2AContextId): void {
    if (this.readySet.has(contextId)) return
    this.readySet.add(contextId)
    this.readyContexts.push(contextId)
  }

  private pump(): void {
    if (this.closed) return
    while (this.active.size < this.maxConcurrentContexts && this.readyContexts.length > 0) {
      const contextId = this.readyContexts.shift()
      if (contextId === undefined) return
      this.readySet.delete(contextId)
      if (this.activeContexts.has(contextId)) continue
      const queue = this.queues.get(contextId)
      if (queue === undefined) {
        this.queues.delete(contextId)
        continue
      }
      const entry = queue.shift()
      if (entry === undefined) {
        this.queues.delete(contextId)
        continue
      }
      if (queue.length === 0) this.queues.delete(contextId)
      this.start(entry)
    }
  }

  private start(entry: ScheduledEntry): void {
    entry.phase = 'active'
    this.active.add(entry)
    this.activeContexts.add(entry.contextId)
    Promise.resolve()
      .then(() => entry.operation(entry.controller.signal))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        entry.phase = 'settled'
        this.entries.delete(entry.taskId)
        this.active.delete(entry)
        this.activeContexts.delete(entry.contextId)
        entry.settle()
        if (!this.closed && this.queues.has(entry.contextId)) this.markReady(entry.contextId)
        this.pump()
      })
  }

  private removeQueued(entry: ScheduledEntry, error: Error): void {
    const queue = this.queues.get(entry.contextId)
    if (queue !== undefined) {
      const index = queue.indexOf(entry)
      if (index >= 0) queue.splice(index, 1)
      if (queue.length === 0) {
        this.queues.delete(entry.contextId)
        this.readySet.delete(entry.contextId)
      }
    }
    entry.phase = 'settled'
    this.entries.delete(entry.taskId)
    entry.controller.abort(error)
    entry.reject(error)
    entry.settle()
  }
}
