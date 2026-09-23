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
  A2ABridgeError,
  A2AContextId,
  A2AFilePublications,
  A2AQuestionBroker,
  A2A_INPUT_RESPONSE_SCHEMA,
  A2ATaskId,
  BoundedContextScheduler,
  DshAgentExecutor,
  StorageDomainA2ARepository,
} from '../lib/index.js'

function deferred() {
  return Promise.withResolvers()
}

function message(messageId, contextId = '', parts = undefined) {
  return {
    messageId,
    contextId,
    taskId: '',
    role: Role.ROLE_USER,
    parts: parts ?? [{ content: { $case: 'text', value: `request:${messageId}` }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function request({ taskId, contextId, messageId, suppliedContextId = '', acceptedOutputModes = [], parts }) {
  return new RequestContext({
    tenant: '',
    message: message(messageId, suppliedContextId, parts),
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
  constructor(delegate, order, onReadTask) {
    this.delegate = delegate
    this.order = order
    this.onReadTask = onReadTask
  }

  getContext(contextId) { return this.delegate.getContext(contextId) }
  async createContext(record) {
    await this.delegate.createContext(record)
    this.order.push(`saved:context:${record.contextId}`)
  }
  async getTask(taskId) {
    const task = await this.delegate.getTask(taskId)
    await this.onReadTask?.(task)
    return task
  }
  getTaskByMessageId(messageId) { return this.delegate.getTaskByMessageId(messageId) }
  async saveTask(task, inputMessageId) {
    await this.delegate.saveTask(task, inputMessageId)
    this.order.push(`saved:task:${task.status.state}`)
    if (task.artifacts.length > 0) this.order.push('saved:artifact')
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
    async prompt(input, signal) {
      calls.prompt.push(input)
      options.order?.push(`prompt:${input.sessionId}`)
      if (options.promptError !== undefined) throw options.promptError
      await options.onPrompt?.(input, signal)
      options.order?.push(`prompt:return:${input.sessionId}`)
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
  const repository = new RecordingRepository(storage.repository, order, options.onReadTask)
  const scheduler = new BoundedContextScheduler(options.concurrency ?? 2)
  const admissions = []
  const interactions = new A2AQuestionBroker()
  const tracker = new ControlledTracker(order)
  const controller = sessionController({
    ...options.controller, order,
    onPrompt: (input, signal) => options.onPrompt?.(input, signal, interactions),
  })
  const deadlines = new ControlledDeadlines()
  const fileTransfer = options.fileTransfer ?? {
    uploadInboundPart: async () => { throw new Error('unexpected file upload') },
    toPart: async () => { throw new Error('unexpected published file') },
  }
  const publications = options.publications ?? new A2AFilePublications()
  const executor = new DshAgentExecutor({
    repository,
    scheduler: {
      run(taskId, contextId, operation) {
        admissions.push({ taskId, contextId })
        return scheduler.run(taskId, contextId, operation)
      },
      cancel: taskId => scheduler.cancel(taskId),
      close: () => scheduler.close(),
    },
    interactions,
    tracker,
    sessionController: controller,
    requestTimeoutMs: 60_000,
    fileTransfer,
    publications,
    fileUrlAllowedOrigin: url => url.origin === 'http://files.internal',
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
      fileTransfer,
      publications,
      interactions,
      admissions,
      order,
    })
  } finally {
    await scheduler.close()
    await interactions.close()
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

test('fails atomically when a later file exceeds the limit before Session prompt admission', async () => {
  let uploads = 0
  const publications = new A2AFilePublications()
  const fileTransfer = {
    async uploadInboundPart() {
      uploads += 1
      if (uploads === 2) {
        throw new A2ABridgeError('A2A_FILE_TOO_LARGE', 'A2A file exceeds the configured byte limit.')
      }
      return { type: 'file', receiptId: 'receipt-first' }
    },
  }
  await withExecutor(async ({ executor, repository, controller }) => {
    const events = eventBus()
    await executor.execute(request({
      taskId: 'task-file-atomic',
      contextId: 'context-file-atomic',
      messageId: 'message-file-atomic',
      parts: [
        { content: { $case: 'raw', value: Buffer.from('first') }, metadata: undefined, filename: 'first.bin', mediaType: 'application/octet-stream' },
        { content: { $case: 'raw', value: Buffer.from('too-large') }, metadata: undefined, filename: 'second.bin', mediaType: 'application/octet-stream' },
      ],
    }), events.bus)

    assert.equal(uploads, 2)
    assert.equal(controller.calls.prompt.length, 0)
    const final = await repository.getTask(A2ATaskId('task-file-atomic'))
    assert.equal(final.status.state, TaskState.TASK_STATE_FAILED)
    assert.equal(final.metadata.dshFailure.code, 'A2A_FILE_TOO_LARGE')
    assert.match(final.status.message.parts[0].content.value, /A2A_FILE_TOO_LARGE/)
    assert.throws(
      () => publications.publish(SessionId('session-created-1'), {
        name: 'late.bin',
        ref: { attachmentId: 'sha256:late', name: 'late.bin', bytes: 1 },
        mediaType: 'application/octet-stream',
      }),
      /active publication window/i,
    )
  }, { fileTransfer, publications })
})

test('cancellation aborts active inbound file admission before prompting the Session', async () => {
  const started = deferred()
  const fileTransfer = {
    uploadInboundPart(_part, _sessionId, _allowedOrigin, signal) {
      started.resolve(signal)
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new A2ABridgeError(
          'A2A_FILE_FETCH_ABORTED', 'A2A file transfer was canceled.', { cause: signal.reason },
        )), { once: true })
      })
    },
  }
  await withExecutor(async ({ executor, controller }) => {
    const events = eventBus()
    const execution = executor.execute(request({
      taskId: 'task-file-cancel',
      contextId: 'context-file-cancel',
      messageId: 'message-file-cancel',
      parts: [{
        content: { $case: 'url', value: 'http://files.internal/wait' },
        metadata: undefined,
        filename: 'wait.bin',
        mediaType: 'application/octet-stream',
      }],
    }), events.bus)
    const signal = await Promise.race([
      started.promise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('file admission did not start')), 250)),
    ])
    await executor.cancelTask('task-file-cancel', events.bus)
    await execution

    assert.equal(signal.aborted, true)
    assert.equal(controller.calls.prompt.length, 0)
    assert.equal(terminalEvents(events.events).at(-1).data.status.state, TaskState.TASK_STATE_CANCELED)
  }, { fileTransfer })
})

test('appends published raw and URL Parts after text and persists links before the final Artifact', async () => {
  let publicationOrder
  const fileTransfer = {
    uploadInboundPart: async () => { throw new Error('unexpected inbound file') },
    async toPart(file) {
      if (file.ref.bytes > 4) {
        publicationOrder.push('link:issued')
        return {
          content: { $case: 'url', value: 'http://agent.internal/a2a/files/large' },
          metadata: undefined,
          filename: file.name,
          mediaType: file.mediaType,
        }
      }
      return {
        content: { $case: 'raw', value: Buffer.from('1234') },
        metadata: undefined,
        filename: file.name,
        mediaType: file.mediaType,
      }
    },
  }
  const publications = new A2AFilePublications()
  await withExecutor(async ({ executor, tracker, repository, publications: active, order: executionOrder }) => {
    publicationOrder = executionOrder
    const events = eventBus()
    const execution = executor.execute(request({
      taskId: 'task-published-files',
      contextId: 'context-published-files',
      messageId: 'message-published-files',
    }), events.bus)
    await tracker.waitStarted(SessionId('session-created-1'))
    active.publish(SessionId('session-created-1'), {
      name: 'small.bin',
      ref: { attachmentId: 'sha256:small-published', name: 'small.bin', bytes: 4 },
      mediaType: 'application/octet-stream',
    })
    active.publish(SessionId('session-created-1'), {
      name: 'large.bin',
      ref: { attachmentId: 'sha256:large-published', name: 'large.bin', bytes: 5 },
      mediaType: 'application/octet-stream',
    })
    tracker.complete(SessionId('session-created-1'), 'done')
    await execution

    const final = await repository.getTask(A2ATaskId('task-published-files'))
    assert.deepEqual(final.artifacts[0].parts.map(part => part.content.$case), ['text', 'raw', 'url'])
    assert.deepEqual(final.artifacts[0].parts.map(part => part.filename), ['', 'small.bin', 'large.bin'])
    assert.ok(executionOrder.indexOf('link:issued') >= 0)
    assert.ok(executionOrder.indexOf('saved:artifact') >= 0)
    assert.ok(executionOrder.indexOf('link:issued') < executionOrder.indexOf('saved:artifact'))
    assert.deepEqual(events.events.filter(event => event.kind === 'artifactUpdate').at(-1).data.artifact, final.artifacts[0])
  }, { fileTransfer, publications })
})

test('fails the Task when hosted-link issuance fails without attaching partial file output', async () => {
  const linkFailure = new Error('link persistence failed')
  const fileTransfer = {
    uploadInboundPart: async () => { throw new Error('unexpected inbound file') },
    async toPart() { throw linkFailure },
  }
  const publications = new A2AFilePublications()
  await withExecutor(async ({ executor, tracker, repository, publications: active }) => {
    const events = eventBus()
    const execution = executor.execute(request({
      taskId: 'task-link-failure',
      contextId: 'context-link-failure',
      messageId: 'message-link-failure',
    }), events.bus)
    await tracker.waitStarted(SessionId('session-created-1'))
    active.publish(SessionId('session-created-1'), {
      name: 'large.bin',
      ref: { attachmentId: 'sha256:large-failure', name: 'large.bin', bytes: 5 },
      mediaType: 'application/octet-stream',
    })
    tracker.complete(SessionId('session-created-1'), 'not returned')
    await execution

    const final = await repository.getTask(A2ATaskId('task-link-failure'))
    assert.equal(final.status.state, TaskState.TASK_STATE_FAILED)
    assert.deepEqual(final.artifacts, [])
    assert.throws(
      () => active.publish(SessionId('session-created-1'), storedForFailure()),
      /active publication window/i,
    )
  }, { fileTransfer, publications })
})

function storedForFailure() {
  return {
    name: 'late.bin',
    ref: { attachmentId: 'sha256:late-failure', name: 'late.bin', bytes: 1 },
    mediaType: 'application/octet-stream',
  }
}

const questionSession = SessionId('session-question')
const questionTask = A2ATaskId('task-question')
const questionContext = A2AContextId('context-question')

async function withQuestion(run, options = {}) {
  const resumed = deferred()
  const answers = []
  await withExecutor(async (harness) => {
    await saveContext(harness.baseRepository, questionContext, questionSession)
    const events = eventBus(harness.order)
    const execution = harness.executor.execute(request({
      taskId: questionTask, contextId: questionContext,
      suppliedContextId: questionContext, messageId: 'initial-question',
    }), events.bus)
    await harness.tracker.waitStarted(questionSession)
    assert.ok(harness.interactions.find(questionTask), 'the live executor must own a question window')
    await events.waitForStatus(TaskState.TASK_STATE_INPUT_REQUIRED)
    await run({ ...harness, events, execution, resumed, answers })
  }, {
    ...options,
    async onPrompt(input, signal, interactions) {
      if (input.sessionId !== questionSession) return
      const answer = await interactions.answer({
        agent: { id: questionSession }, signal,
        questions: [{ id: 'decision', question: 'Which action?', options: [{ label: 'Approve' }, { label: 'Reject' }] }],
      }, async () => { throw new Error('A2A question escaped to another answerer') })
      answers.push(answer)
      resumed.resolve(answer)
    },
  })
}

async function appendAnswer(harness, messageId, parts) {
  const continuation = request({
    taskId: questionTask, contextId: questionContext, suppliedContextId: questionContext,
    messageId, parts,
  })
  const task = await harness.repository.getTask(questionTask)
  // The SDK saves the caller Message before invoking its executor.
  await harness.repository.saveTask({
    ...task, history: [...task.history, { ...continuation.userMessage, taskId: questionTask }],
  })
  return continuation
}

function answerParts(label) {
  return [{
    content: { $case: 'data', value: {
      schema: A2A_INPUT_RESPONSE_SCHEMA,
      answers: [{ id: 'decision', selected: [label] }],
    } },
    metadata: undefined, filename: '', mediaType: 'application/json',
  }]
}

test('input-required retains the pending prompt, context lock, and concurrency slot', async () => {
  await withQuestion(async h => {
    const pending = await h.repository.getTask(questionTask)
    assert.equal(pending.status.state, TaskState.TASK_STATE_INPUT_REQUIRED)
    assert.deepEqual(pending.history.map(item => item.role), [Role.ROLE_USER, Role.ROLE_AGENT])
    assert.deepEqual(pending.status.message, pending.history.at(-1))
    assert.equal(h.order.includes(`prompt:return:${questionSession}`), false)
    assert.ok(h.order.indexOf(`saved:task:${TaskState.TASK_STATE_INPUT_REQUIRED}`)
      < h.order.indexOf(`event:statusUpdate:${TaskState.TASK_STATE_INPUT_REQUIRED}`))
    const queued = []
    for (const [taskId, contextId] of [['same-context', questionContext], ['other-context', 'context-other']]) {
      if (contextId !== questionContext) await saveContext(h.baseRepository, contextId, 'session-other')
      const events = eventBus()
      queued.push(h.executor.execute(request({ taskId, contextId, suppliedContextId: contextId, messageId: taskId }), events.bus))
      await events.waitForStatus(TaskState.TASK_STATE_WORKING)
    }
    assert.equal(h.controller.calls.prompt.length, 1)
    await h.executor.cancelTask('same-context', eventBus().bus)
    await h.executor.cancelTask('other-context', eventBus().bus)
    await Promise.all(queued)
    await h.executor.cancelTask(questionTask, h.events.bus)
    await h.execution
    assert.equal(h.answers.length, 0)
    assert.equal(terminalEvents(h.events.events).length, 1)
    assert.equal(h.interactions.find(questionTask), undefined)
  }, { concurrency: 1 })
})

test('same-Task answer persists working before releasing the original prompt and preserves SDK history', async () => {
  await withQuestion(async h => {
    const continuation = await appendAnswer(h, 'valid-answer', answerParts('Approve'))
    const answerEvents = eventBus()
    let requestDrained = false
    void h.execution.then(() => { requestDrained = true })
    const continued = h.executor.execute(continuation, answerEvents.bus)
    const answer = await h.resumed.promise
    assert.equal(requestDrained, false)
    assert.deepEqual(answer, { answers: [{ id: 'decision', selected: ['Approve'] }] })
    assert.equal((await h.repository.getTask(questionTask)).status.state, TaskState.TASK_STATE_WORKING)
    assert.equal(h.events.events.at(-1).data.status.state, TaskState.TASK_STATE_WORKING)
    assert.equal(h.controller.calls.create.length, 0)
    assert.equal(h.controller.calls.prompt.length, 1)
    assert.equal(h.admissions.length, 1)
    assert.equal(h.deadlines.items.length, 1)
    h.tracker.complete(questionSession, 'approved')
    await Promise.all([h.execution, continued])
    const final = await h.repository.getTask(questionTask)
    assert.equal(final.status.state, TaskState.TASK_STATE_COMPLETED)
    assert.deepEqual(final.history.map(item => item.messageId), [
      'initial-question', final.history[1].messageId, 'valid-answer',
    ])
    assert.deepEqual(answerEvents.events.at(-1).data, final)
    assert.equal(terminalEvents(h.events.events).length, 1)
    assert.equal(h.order.filter(item => item === `saved:task:${TaskState.TASK_STATE_COMPLETED}`).length, 1)
  })
})

test('invalid structured input appends a validation question and retains the pending tool', async () => {
  await withQuestion(async h => {
    const invalid = await appendAnswer(h, 'invalid-answer', answerParts('Unknown'))
    const invalidEvents = eventBus()
    await h.executor.execute(invalid, invalidEvents.bus)
    const pending = await h.repository.getTask(questionTask)
    assert.equal(pending.status.state, TaskState.TASK_STATE_INPUT_REQUIRED)
    assert.deepEqual(pending.history.map(item => item.role), [Role.ROLE_USER, Role.ROLE_AGENT, Role.ROLE_USER, Role.ROLE_AGENT])
    assert.equal(pending.history[2].messageId, 'invalid-answer')
    assert.equal(pending.status.message.parts[1].content.value.error.code, 'A2A_INTERACTION_INVALID_RESPONSE')
    assert.equal(h.answers.length, 0)
    assert.equal(h.controller.calls.prompt.length, 1)
    const valid = await appendAnswer(h, 'corrected-answer', answerParts('Reject'))
    const continued = h.executor.execute(valid, eventBus().bus)
    await h.resumed.promise
    h.tracker.complete(questionSession, 'rejected')
    await Promise.all([h.execution, continued])
    assert.equal((await h.repository.getTask(questionTask)).history.length, 5)
  })
})

test('simultaneous answers, retries, and late Messages resolve one tool and never admit another turn', async () => {
  const workingRead = deferred()
  let observeLateRead = false
  await withQuestion(async h => {
    const first = await appendAnswer(h, 'answer-first', answerParts('Approve'))
    const second = await appendAnswer(h, 'answer-second', answerParts('Reject'))
    const release = deferred()
    const firstRun = release.promise.then(() => h.executor.execute(first, eventBus().bus))
    const secondRun = release.promise.then(() => h.executor.execute(second, eventBus().bus))
    const retryRun = release.promise.then(() => h.executor.execute(first, eventBus().bus))
    release.resolve()
    await h.resumed.promise
    const late = await appendAnswer(h, 'answer-late', answerParts('Reject'))
    const lateEvents = eventBus()
    observeLateRead = true
    const lateRun = h.executor.execute(late, lateEvents.bus)
    await workingRead.promise
    observeLateRead = false
    h.tracker.complete(questionSession, 'one second model phase')
    await Promise.all([h.execution, firstRun, secondRun, retryRun, lateRun])
    const terminal = await h.repository.getTask(questionTask)
    const terminalEventsBus = eventBus()
    await h.executor.execute(request({
      taskId: questionTask, contextId: questionContext, suppliedContextId: questionContext,
      messageId: 'after-terminal', parts: answerParts('Reject'),
    }), terminalEventsBus.bus)
    assert.equal(h.answers.length, 1)
    assert.equal(h.admissions.length, 1)
    assert.equal(h.controller.calls.prompt.length, 1)
    assert.equal(h.controller.calls.create.length, 0)
    assert.equal(h.order.filter(item => item === `saved:task:${TaskState.TASK_STATE_COMPLETED}`).length, 1)
    assert.equal(terminalEvents(h.events.events).length, 1)
    assert.deepEqual(terminal.history.slice(2).map(item => item.messageId), ['answer-first', 'answer-second', 'answer-late'])
    assert.deepEqual(lateEvents.events, [{ kind: 'task', data: terminal }])
    assert.deepEqual(terminalEventsBus.events, [{ kind: 'task', data: terminal }])
  }, {
    onReadTask(task) {
      if (observeLateRead && task?.status.state === TaskState.TASK_STATE_WORKING) workingRead.resolve()
    },
  })
})

test('reloads the terminal Task when completion removes the execution during a continuation read', async () => {
  const captured = deferred()
  const release = deferred()
  let holdRead = false
  await withQuestion(async h => {
    const answer = await appendAnswer(h, 'answer-before-completion', answerParts('Approve'))
    const continued = h.executor.execute(answer, eventBus().bus)
    await h.resumed.promise
    const late = await appendAnswer(h, 'answer-during-completion', answerParts('Reject'))
    const lateEvents = eventBus()
    holdRead = true
    const lateRun = h.executor.execute(late, lateEvents.bus)
    try {
      await captured.promise
      h.tracker.complete(questionSession, 'completed before continuation read returns')
      await Promise.all([h.execution, continued])
      const terminal = await h.baseRepository.getTask(questionTask)
      assert.equal(terminal.status.state, TaskState.TASK_STATE_COMPLETED)
      release.resolve()
      await lateRun
      assert.deepEqual(lateEvents.events, [{ kind: 'task', data: terminal }])
      assert.equal(h.admissions.length, 1)
      assert.equal(h.controller.calls.prompt.length, 1)
      assert.equal(h.controller.calls.create.length, 0)
    } finally {
      release.resolve()
      await lateRun
    }
  }, {
    async onReadTask(task) {
      if (!holdRead || task?.status.state !== TaskState.TASK_STATE_WORKING) return
      holdRead = false
      captured.resolve()
      await release.promise
    },
  })
})
