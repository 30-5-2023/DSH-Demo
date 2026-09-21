import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Role, TaskState } from '@a2a-js/sdk'
import { TaskNotFoundError } from '@a2a-js/sdk/errors'
import { DefaultExecutionEventBus, RequestContext } from '@a2a-js/sdk/server'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  A2AContextId,
  A2ATaskId,
  BoundedContextScheduler,
  DshAgentExecutor,
  StorageDomainA2ARepository,
} from '../lib/index.js'

function deferred() {
  return Promise.withResolvers()
}

function message(messageId, contextId = '') {
  return {
    messageId,
    contextId,
    taskId: '',
    role: Role.ROLE_USER,
    parts: [{ content: { $case: 'text', value: `request:${messageId}` }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function request({ taskId, contextId, messageId, suppliedContextId = '', acceptedOutputModes = [] }) {
  return new RequestContext({
    tenant: '',
    message: message(messageId, suppliedContextId),
    configuration: {
      acceptedOutputModes,
      taskPushNotificationConfig: undefined,
      returnImmediately: false,
    },
    metadata: undefined,
  }, taskId, contextId, { tenant: '', user: { isAuthenticated: false } })
}

function eventBus(order = []) {
  const bus = new DefaultExecutionEventBus()
  const events = []
  const statusWaiters = new Map()
  bus.on('event', (event) => {
    events.push(event)
    order.push(`event:${event.kind}:${event.kind === 'task' ? event.data.status.state : event.kind === 'statusUpdate' ? event.data.status.state : ''}`)
    const state = event.kind === 'task' ? event.data.status.state : event.kind === 'statusUpdate' ? event.data.status.state : undefined
    statusWaiters.get(state)?.resolve()
  })
  return {
    bus,
    events,
    waitForStatus(state) {
      if (events.some(event => (event.kind === 'task' || event.kind === 'statusUpdate') && event.data.status.state === state)) {
        return Promise.resolve()
      }
      const waiter = statusWaiters.get(state) ?? deferred()
      statusWaiters.set(state, waiter)
      return waiter.promise
    },
  }
}

function terminalEvents(events) {
  return events.filter(event => event.kind === 'statusUpdate' && [
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
  ].includes(event.data.status.state))
}

class RecordingRepository {
  constructor(delegate, order) {
    this.delegate = delegate
    this.order = order
  }

  getContext(contextId) { return this.delegate.getContext(contextId) }
  async createContext(record) {
    await this.delegate.createContext(record)
    this.order.push(`saved:context:${record.contextId}`)
  }
  getTask(taskId) { return this.delegate.getTask(taskId) }
  getTaskByMessageId(messageId) { return this.delegate.getTaskByMessageId(messageId) }
  async saveTask(task, inputMessageId) {
    await this.delegate.saveTask(task, inputMessageId)
    this.order.push(`saved:task:${task.status.state}`)
  }
  markInterruptedTasksFailed(now) { return this.delegate.markInterruptedTasksFailed(now) }
  close() { return Promise.resolve() }
}

class ControlledTracker {
  constructor(order) {
    this.order = order
    this.pending = new Map()
    this.started = new Map()
  }

  track(input) {
    this.order.push(`track:${input.sessionId}`)
    const result = deferred()
    const started = this.started.get(input.sessionId) ?? deferred()
    this.started.set(input.sessionId, started)
    this.pending.set(input.sessionId, { input, result })
    const abort = () => result.reject(input.signal.reason)
    input.signal.addEventListener('abort', abort, { once: true })
    result.promise.then(
      () => input.signal.removeEventListener('abort', abort),
      () => input.signal.removeEventListener('abort', abort),
    )
    started.resolve(input)
    return result.promise
  }

  waitStarted(sessionId) {
    const started = this.started.get(sessionId) ?? deferred()
    this.started.set(sessionId, started)
    return started.promise
  }

  complete(sessionId, text, reason = { kind: 'completed' }) {
    const pending = this.pending.get(sessionId)
    assert.ok(pending, `tracker must own ${sessionId}`)
    pending.result.resolve({ turn: 1, text, reason })
  }

  close() { return Promise.resolve() }
}

class ControlledDeadlines {
  constructor() { this.items = [] }
  create() {
    const controller = new AbortController()
    const item = { controller, closed: false }
    this.items.push(item)
    return { signal: controller.signal, close: () => { item.closed = true } }
  }
}

function sessionController(options = {}) {
  const calls = { create: [], prompt: [], cancel: [] }
  let createIndex = 0
  return {
    calls,
    async create(input) {
      calls.create.push(input)
      if (options.createError !== undefined) throw options.createError
      createIndex += 1
      return { sessionId: SessionId(options.createdSessionId ?? `session-created-${createIndex}`) }
    },
    async prompt(input) {
      calls.prompt.push(input)
      options.order?.push(`prompt:${input.sessionId}`)
      if (options.promptError !== undefined) throw options.promptError
      return { accepted: true }
    },
    cancel(input) {
      calls.cancel.push(input)
      return { accepted: true }
    },
  }
}

async function openRepository() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-executor-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  const repository = await StorageDomainA2ARepository.open(facility)
  return {
    repository,
    async close() {
      await repository.close()
      await backend.close()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function withExecutor(run, options = {}) {
  const storage = await openRepository()
  const order = []
  const repository = new RecordingRepository(storage.repository, order)
  const scheduler = new BoundedContextScheduler(options.concurrency ?? 2)
  const tracker = new ControlledTracker(order)
  const controller = sessionController({ ...options.controller, order })
  const deadlines = new ControlledDeadlines()
  const executor = new DshAgentExecutor({
    repository,
    scheduler,
    tracker,
    sessionController: controller,
    requestTimeoutMs: 60_000,
    agentPreset: 'business-agent',
    deadlineFactory: timeoutMs => {
      assert.equal(timeoutMs, 60_000)
      return deadlines.create()
    },
  })
  try {
    await run({
      executor,
      repository,
      baseRepository: storage.repository,
      scheduler,
      tracker,
      controller,
      deadlines,
      order,
    })
  } finally {
    await scheduler.close()
    await storage.close()
  }
}

async function saveContext(repository, contextId, sessionId) {
  await repository.createContext({
    contextId: A2AContextId(contextId),
    sessionId: SessionId(sessionId),
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  })
}

test('creates a Session, persists before publication, and completes text output in order', async () => {
  await withExecutor(async ({ executor, repository, tracker, controller, deadlines, order }) => {
    const events = eventBus(order)
    const execution = executor.execute(request({
      taskId: 'task-new', contextId: 'context-new', messageId: 'message-new',
    }), events.bus)

    await tracker.waitStarted(SessionId('session-created-1'))
    assert.deepEqual(controller.calls.create, [{ agentPreset: 'business-agent' }])
    assert.equal(controller.calls.prompt.length, 1)
    assert.deepEqual(order.slice(0, 7), [
      `saved:task:${TaskState.TASK_STATE_SUBMITTED}`,
      `event:task:${TaskState.TASK_STATE_SUBMITTED}`,
      'saved:context:context-new',
      `saved:task:${TaskState.TASK_STATE_WORKING}`,
      `event:statusUpdate:${TaskState.TASK_STATE_WORKING}`,
      'track:session-created-1',
      'prompt:session-created-1',
    ])
    tracker.complete(SessionId('session-created-1'), 'finished')
    await execution

    assert.deepEqual(events.events.map(event => event.kind), ['task', 'statusUpdate', 'artifactUpdate', 'statusUpdate'])
    assert.equal(events.events[2].data.artifact.parts[0].content.value, 'finished')
    assert.equal(events.events[3].data.status.state, TaskState.TASK_STATE_COMPLETED)
    assert.equal(terminalEvents(events.events).length, 1)
    const final = await repository.getTask(A2ATaskId('task-new'))
    assert.equal(final.status.state, TaskState.TASK_STATE_COMPLETED)
    assert.equal(final.artifacts[0].parts[0].content.value, 'finished')
    assert.equal((await repository.getContext(A2AContextId('context-new'))).sessionId, SessionId('session-created-1'))
    assert.equal(deadlines.items[0].closed, true)
  })
})

test('continues a known context and returns requested JSON output', async () => {
  await withExecutor(async ({ executor, baseRepository, tracker, controller }) => {
    await saveContext(baseRepository, 'context-known', 'session-known')
    const events = eventBus()
    const execution = executor.execute(request({
      taskId: 'task-json',
      contextId: 'context-known',
      suppliedContextId: 'context-known',
      messageId: 'message-json',
      acceptedOutputModes: ['application/json'],
    }), events.bus)

    await tracker.waitStarted(SessionId('session-known'))
    assert.equal(controller.calls.create.length, 0)
    assert.equal(controller.calls.prompt[0].sessionId, SessionId('session-known'))
    assert.match(controller.calls.prompt[0].content.at(-1).text, /exactly one JSON object/)
    tracker.complete(SessionId('session-known'), '{"ok":true}')
    await execution

    assert.deepEqual(events.events[2].data.artifact.parts[0].content, { $case: 'data', value: { ok: true } })
    assert.equal(events.events.at(-1).data.status.state, TaskState.TASK_STATE_COMPLETED)
  })
})

test('rejects an unknown caller-supplied context without creating a Task or Session', async () => {
  await withExecutor(async ({ executor, repository, controller }) => {
    const events = eventBus()
    await assert.rejects(executor.execute(request({
      taskId: 'task-unknown',
      contextId: 'context-unknown',
      suppliedContextId: 'context-unknown',
      messageId: 'message-unknown',
    }), events.bus), error => error instanceof TaskNotFoundError)

    assert.deepEqual(events.events, [])
    assert.equal(await repository.getTask(A2ATaskId('task-unknown')), undefined)
    assert.equal(controller.calls.create.length, 0)
    assert.equal(controller.calls.prompt.length, 0)
  })
})

test('maps Session creation and prompt failures to stable safe terminal Tasks', async () => {
  for (const failingStage of ['create', 'prompt']) {
    await withExecutor(async ({ executor, repository, controller }) => {
      const events = eventBus()
      await executor.execute(request({
        taskId: `task-${failingStage}`,
        contextId: `context-${failingStage}`,
        messageId: `message-${failingStage}`,
      }), events.bus)

      assert.equal(events.events[0].kind, 'task')
      assert.equal(events.events[0].data.status.state, TaskState.TASK_STATE_SUBMITTED)
      assert.equal(terminalEvents(events.events).length, 1)
      const terminal = terminalEvents(events.events)[0]
      assert.equal(terminal.data.status.state, TaskState.TASK_STATE_FAILED)
      const publicText = terminal.data.status.message.parts[0].content.value
      assert.match(publicText, new RegExp(`A2A_SESSION_${failingStage.toUpperCase()}_FAILED`))
      assert.doesNotMatch(publicText, /secret prompt|credential/i)
      const final = await repository.getTask(A2ATaskId(`task-${failingStage}`))
      assert.equal(final.status.state, TaskState.TASK_STATE_FAILED)
      if (failingStage === 'create') assert.equal(controller.calls.prompt.length, 0)
    }, {
      controller: failingStage === 'create'
        ? { createError: new Error('secret prompt credential during create') }
        : { promptError: new Error('secret prompt credential during prompt') },
    })
  }
})

test('timeout aborts tracking, cancels only the owning Session, and records failed', async () => {
  await withExecutor(async ({ executor, baseRepository, tracker, controller, deadlines, repository }) => {
    await saveContext(baseRepository, 'context-timeout', 'session-timeout')
    const events = eventBus()
    const execution = executor.execute(request({
      taskId: 'task-timeout',
      contextId: 'context-timeout',
      suppliedContextId: 'context-timeout',
      messageId: 'message-timeout',
    }), events.bus)

    await tracker.waitStarted(SessionId('session-timeout'))
    deadlines.items[0].controller.abort(new Error('controlled deadline'))
    await execution

    assert.deepEqual(controller.calls.cancel, [{ sessionId: SessionId('session-timeout') }])
    assert.equal(terminalEvents(events.events).length, 1)
    assert.match(terminalEvents(events.events)[0].data.status.message.parts[0].content.value, /A2A_EXECUTION_TIMEOUT/)
    assert.equal((await repository.getTask(A2ATaskId('task-timeout'))).status.state, TaskState.TASK_STATE_FAILED)
  })
})

test('queued and active cancellation stay isolated and each task publishes one terminal state', async () => {
  await withExecutor(async ({ executor, baseRepository, tracker, controller }) => {
    await saveContext(baseRepository, 'context-active', 'session-active')
    await saveContext(baseRepository, 'context-queued', 'session-queued')
    const activeEvents = eventBus()
    const queuedEvents = eventBus()
    const activeExecution = executor.execute(request({
      taskId: 'task-active', contextId: 'context-active', suppliedContextId: 'context-active', messageId: 'message-active',
    }), activeEvents.bus)
    await tracker.waitStarted(SessionId('session-active'))
    const queuedExecution = executor.execute(request({
      taskId: 'task-queued', contextId: 'context-queued', suppliedContextId: 'context-queued', messageId: 'message-queued',
    }), queuedEvents.bus)

    await queuedEvents.waitForStatus(TaskState.TASK_STATE_WORKING)
    await executor.cancelTask('task-queued', queuedEvents.bus)
    await queuedExecution
    assert.equal(controller.calls.cancel.length, 0)
    assert.equal(terminalEvents(queuedEvents.events).length, 1)
    assert.equal(terminalEvents(queuedEvents.events)[0].data.status.state, TaskState.TASK_STATE_CANCELED)

    await executor.cancelTask('task-active', activeEvents.bus)
    await activeExecution
    assert.deepEqual(controller.calls.cancel, [{ sessionId: SessionId('session-active') }])
    assert.equal(terminalEvents(activeEvents.events).length, 1)
    assert.equal(terminalEvents(activeEvents.events)[0].data.status.state, TaskState.TASK_STATE_CANCELED)
  }, { concurrency: 1 })
})

test('cancel racing completion commits one terminal state and never cancels a sibling Session', async () => {
  await withExecutor(async ({ executor, baseRepository, tracker, controller }) => {
    await saveContext(baseRepository, 'context-race', 'session-race')
    await saveContext(baseRepository, 'context-sibling', 'session-sibling')
    const raceEvents = eventBus()
    const siblingEvents = eventBus()
    const raceExecution = executor.execute(request({
      taskId: 'task-race', contextId: 'context-race', suppliedContextId: 'context-race', messageId: 'message-race',
    }), raceEvents.bus)
    const siblingExecution = executor.execute(request({
      taskId: 'task-sibling', contextId: 'context-sibling', suppliedContextId: 'context-sibling', messageId: 'message-sibling',
    }), siblingEvents.bus)
    await Promise.all([
      tracker.waitStarted(SessionId('session-race')),
      tracker.waitStarted(SessionId('session-sibling')),
    ])

    tracker.complete(SessionId('session-race'), 'race-result')
    await Promise.all([executor.cancelTask('task-race', raceEvents.bus), raceExecution])
    assert.equal(terminalEvents(raceEvents.events).length, 1)
    assert.ok([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_CANCELED].includes(
      terminalEvents(raceEvents.events)[0].data.status.state,
    ))
    assert.deepEqual(controller.calls.cancel, [{ sessionId: SessionId('session-race') }])

    tracker.complete(SessionId('session-sibling'), 'sibling-result')
    await siblingExecution
    assert.equal(terminalEvents(siblingEvents.events).length, 1)
    assert.equal(terminalEvents(siblingEvents.events)[0].data.status.state, TaskState.TASK_STATE_COMPLETED)
  })
})

test('canceling a terminal Task returns it unchanged', async () => {
  await withExecutor(async ({ executor, baseRepository, tracker, repository }) => {
    await saveContext(baseRepository, 'context-terminal', 'session-terminal')
    const events = eventBus()
    const execution = executor.execute(request({
      taskId: 'task-terminal', contextId: 'context-terminal', suppliedContextId: 'context-terminal', messageId: 'message-terminal',
    }), events.bus)
    await tracker.waitStarted(SessionId('session-terminal'))
    tracker.complete(SessionId('session-terminal'), 'done')
    await execution
    const before = await repository.getTask(A2ATaskId('task-terminal'))

    const cancelEvents = eventBus()
    await executor.cancelTask('task-terminal', cancelEvents.bus)
    const after = await repository.getTask(A2ATaskId('task-terminal'))
    assert.deepEqual(after, before)
    assert.deepEqual(cancelEvents.events, [{ kind: 'task', data: before }])
  })
})
