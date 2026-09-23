import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Role, TaskState } from '@a2a-js/sdk'
import { RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors'
import { AgentEvent, ServerCallContext } from '@a2a-js/sdk/server'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import {
  A2AMessageId,
  BridgeRequestHandler,
  DomainTaskStore,
  StorageDomainA2ARepository,
} from '../lib/index.js'

function deferred() {
  return Promise.withResolvers()
}

function card() {
  return {
    name: 'Test Agent',
    description: 'Request handler test Agent',
    supportedInterfaces: [{ url: 'http://127.0.0.1:3081/a2a', protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
    provider: undefined,
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{
      id: 'test', name: 'Test', description: 'Test', tags: ['test'], examples: [],
      inputModes: ['text/plain'], outputModes: ['text/plain'], securityRequirements: [],
    }],
    signatures: [],
  }
}

function sendRequest(messageId = 'message-dedup') {
  return {
    tenant: '',
    message: {
      messageId,
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [{ content: { $case: 'text', value: 'run once' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: ['text/plain'],
      taskPushNotificationConfig: undefined,
      returnImmediately: false,
    },
    metadata: undefined,
  }
}

function callContext() {
  return new ServerCallContext({ tenant: '', requestedVersion: '1.0' })
}

function taskWithState(task, state, artifacts = task.artifacts) {
  return {
    ...task,
    artifacts,
    status: { state, message: undefined, timestamp: new Date().toISOString() },
  }
}

class CountingRepository {
  constructor(delegate) {
    this.delegate = delegate
    this.taskIds = new Set()
  }
  getContext(contextId) { return this.delegate.getContext(contextId) }
  createContext(record) { return this.delegate.createContext(record) }
  getTask(taskId, observe) { return this.delegate.getTask(taskId, observe) }
  getTaskByMessageId(messageId) { return this.delegate.getTaskByMessageId(messageId) }
  updateTask(taskId, update) { return this.delegate.updateTask(taskId, update) }
  async saveTask(task, messageId) {
    this.taskIds.add(task.id)
    await this.delegate.saveTask(task, messageId)
  }
  markInterruptedTasksFailed(now) { return this.delegate.markInterruptedTasksFailed(now) }
  close() { return Promise.resolve() }
}

class BarrierExecutor {
  constructor(repository) {
    this.repository = repository
    this.started = deferred()
    this.release = deferred()
    this.promptCount = 0
    this.newContextAdmissions = []
  }

  allowNewContext(messageId) { this.newContextAdmissions.push(messageId) }

  async execute(request, events) {
    this.promptCount += 1
    const message = { ...request.userMessage, taskId: request.taskId, contextId: request.contextId }
    const submitted = taskWithState({
      id: request.taskId,
      contextId: request.contextId,
      status: undefined,
      artifacts: [],
      history: [message],
      metadata: undefined,
    }, TaskState.TASK_STATE_SUBMITTED)
    await this.repository.saveTask(submitted, A2AMessageId(message.messageId))
    events.publish(AgentEvent.task(submitted))
    const working = taskWithState(submitted, TaskState.TASK_STATE_WORKING)
    await this.repository.saveTask(working)
    events.publish(AgentEvent.statusUpdate({
      taskId: working.id,
      contextId: working.contextId,
      status: working.status,
      metadata: undefined,
    }))
    events.publish(AgentEvent.artifactUpdate({
      taskId: working.id,
      contextId: working.contextId,
      artifact: {
        artifactId: 'result', name: 'result', description: '',
        parts: [{ content: { $case: 'text', value: 'partial' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
        metadata: undefined, extensions: [],
      },
      append: true,
      lastChunk: false,
      metadata: undefined,
    }))
    this.started.resolve({ taskId: request.taskId, contextId: request.contextId })
    await this.release.promise
    const artifact = {
      artifactId: 'result', name: 'result', description: '',
      parts: [{ content: { $case: 'text', value: 'complete' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
      metadata: undefined, extensions: [],
    }
    const completed = taskWithState(working, TaskState.TASK_STATE_COMPLETED, [artifact])
    await this.repository.saveTask(completed)
    events.publish(AgentEvent.artifactUpdate({
      taskId: completed.id,
      contextId: completed.contextId,
      artifact,
      append: false,
      lastChunk: true,
      metadata: undefined,
    }))
    events.publish(AgentEvent.statusUpdate({
      taskId: completed.id,
      contextId: completed.contextId,
      status: completed.status,
      metadata: undefined,
    }))
  }

  async cancelTask(taskId, events) {
    const task = await this.repository.getTask(taskId)
    if (task === undefined) throw new TaskNotFoundError(`Task not found: ${taskId}`)
    const canceled = taskWithState(task, TaskState.TASK_STATE_CANCELED)
    await this.repository.saveTask(canceled)
    events.publish(AgentEvent.statusUpdate({
      taskId: canceled.id,
      contextId: canceled.contextId,
      status: canceled.status,
      metadata: undefined,
    }))
    this.release.resolve()
  }
}

class ObservedTaskStore extends DomainTaskStore {
  constructor(repository) {
    super(repository)
    this.workingSaved = deferred()
  }

  async save(task, context) {
    await super.save(task, context)
    if (task.status?.state === TaskState.TASK_STATE_WORKING) this.workingSaved.resolve()
  }
}

async function openHarness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-handler-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  const storage = await StorageDomainA2ARepository.open(facility)
  const repository = new CountingRepository(storage)
  const executor = new BarrierExecutor(repository)
  const taskStore = new ObservedTaskStore(repository)
  const handler = new BridgeRequestHandler(card(), taskStore, executor, repository)
  return {
    handler,
    executor,
    repository,
    taskStore,
    async close() {
      executor.release.resolve()
      await storage.close()
      await backend.close()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function collect(stream) {
  const values = []
  for await (const value of stream) values.push(value)
  return values
}

test('single-flights simultaneous sync and stream retries by durable message id', async () => {
  const harness = await openHarness()
  try {
    const params = sendRequest()
    const first = harness.handler.sendMessage(params, callContext())
    const ids = await harness.executor.started.promise
    const duplicateSync = harness.handler.sendMessage(params, callContext())
    const duplicateStream = collect(harness.handler.sendMessageStream(params, callContext()))

    await harness.taskStore.workingSaved.promise
    harness.executor.release.resolve()
    const [firstTask, syncTask, stream] = await Promise.all([first, duplicateSync, duplicateStream])
    assert.equal(harness.executor.promptCount, 1)
    assert.deepEqual(harness.executor.newContextAdmissions, ['message-dedup'])
    assert.equal(harness.repository.taskIds.size, 1)
    assert.equal(firstTask.id, ids.taskId)
    assert.equal(syncTask.id, ids.taskId)
    assert.equal(firstTask.contextId, ids.contextId)
    assert.equal(syncTask.contextId, ids.contextId)
    assert.equal(firstTask.status.state, TaskState.TASK_STATE_COMPLETED)
    assert.deepEqual(stream, [{ payload: { $case: 'task', value: firstTask } }])

    const durable = await harness.repository.getTaskByMessageId(A2AMessageId('message-dedup'))
    assert.equal(durable.id, ids.taskId)
    assert.equal(durable.status.state, TaskState.TASK_STATE_COMPLETED)

    const terminalSync = await harness.handler.sendMessage(params, callContext())
    const terminalStream = await collect(harness.handler.sendMessageStream(params, callContext()))
    assert.equal(terminalSync.id, ids.taskId)
    assert.deepEqual(terminalStream, [{ payload: { $case: 'task', value: durable } }])
    assert.equal(harness.executor.promptCount, 1)
  } finally {
    await harness.close()
  }
})

test('allows Card, send, stream, get, and cancel while rejecting every deferred operation', async () => {
  const harness = await openHarness()
  try {
    assert.equal((await harness.handler.getAgentCard()).name, 'Test Agent')
    await assert.rejects(harness.handler.getTask({ tenant: '', id: 'missing', historyLength: undefined }, callContext()), error => error instanceof TaskNotFoundError)
    await assert.rejects(harness.handler.cancelTask({ tenant: '', id: 'missing' }, callContext()), error => error instanceof TaskNotFoundError)

    const unsupported = error => error instanceof UnsupportedOperationError
    await assert.rejects(harness.handler.listTasks({}), unsupported)
    await assert.rejects(harness.handler.getAuthenticatedExtendedAgentCard({}, callContext()), unsupported)
    await assert.rejects(harness.handler.createTaskPushNotificationConfig({}, callContext()), unsupported)
    await assert.rejects(harness.handler.getTaskPushNotificationConfig({}, callContext()), unsupported)
    await assert.rejects(harness.handler.listTaskPushNotificationConfigs({}, callContext()), unsupported)
    await assert.rejects(harness.handler.deleteTaskPushNotificationConfig({}, callContext()), unsupported)
    await assert.rejects(harness.handler.resubscribe({}, callContext()).next(), unsupported)
  } finally {
    await harness.close()
  }
})

test('same-Task admission appends the answer, infers context, and rejects invalid destinations', async () => {
  const harness = await openHarness()
  try {
    const pending = taskWithState({ id: 'pending-task', contextId: 'pending-context', artifacts: [], history: [] }, TaskState.TASK_STATE_INPUT_REQUIRED)
    await harness.repository.saveTask(pending)
    const calls = []
    const handler = new BridgeRequestHandler(card(), harness.taskStore, {
      allowNewContext() { assert.fail('a same-Task answer must not reserve a new context') },
      async execute(request, events) {
        calls.push(request)
        const task = await harness.repository.getTask(request.taskId)
        assert.equal(task.history.at(-1).messageId, request.userMessage.messageId)
        events.publish(AgentEvent.task(task))
        const completed = taskWithState(task, TaskState.TASK_STATE_COMPLETED)
        await harness.repository.saveTask(completed)
        events.publish(AgentEvent.statusUpdate({ taskId: task.id, contextId: task.contextId, status: completed.status }))
      },
      async cancelTask() {},
    }, harness.repository)
    const answer = sendRequest('answer-admission')
    answer.message.taskId = pending.id
    const mismatched = structuredClone(answer)
    mismatched.message.messageId = 'mismatched-answer'
    mismatched.message.contextId = 'other-context'
    await assert.rejects(handler.sendMessage(mismatched, callContext()), error => error instanceof RequestMalformedError)
    const unknown = structuredClone(answer)
    unknown.message.messageId = 'unknown-answer'
    unknown.message.taskId = 'missing'
    await assert.rejects(handler.sendMessage(unknown, callContext()), error => error instanceof TaskNotFoundError)
    const completed = await handler.sendMessage(answer, callContext())
    assert.equal(completed.id, pending.id)
    assert.equal(calls[0].contextId, pending.contextId)
    assert.equal(calls[0].userMessage.contextId, pending.contextId)
    const terminal = structuredClone(answer)
    terminal.message.messageId = 'terminal-answer'
    await assert.rejects(handler.sendMessage(terminal, callContext()), error => error instanceof UnsupportedOperationError)
    assert.equal(calls.length, 1)
  } finally {
    await harness.close()
  }
})

test('SDK answer admission merges into the executor state committed while admission is paused', async () => {
  const harness = await openHarness()
  const entered = deferred()
  const release = deferred()
  const pending = taskWithState({ id: 'admission-task', contextId: 'admission-context', artifacts: [], history: [] }, TaskState.TASK_STATE_INPUT_REQUIRED)
  let response
  try {
    await harness.repository.saveTask(pending)
    const taskStore = new DomainTaskStore({
      getTask: id => harness.repository.getTask(id),
      async updateTask(id, update) {
        entered.resolve()
        await release.promise
        return harness.repository.updateTask(id, update)
      },
    })
    const handler = new BridgeRequestHandler(card(), taskStore, {
      async execute(request, events) {
        const current = await harness.repository.getTask(request.taskId)
        assert.equal(current.status.state, TaskState.TASK_STATE_WORKING)
        assert.equal(current.history.at(-1).messageId, 'admission-answer')
        assert.equal(current.metadata.executed, true)
        events.publish(AgentEvent.task(current))
        const completed = await harness.repository.updateTask(request.taskId,
          task => taskWithState(task, TaskState.TASK_STATE_COMPLETED))
        events.publish(AgentEvent.statusUpdate({ taskId: current.id, contextId: current.contextId, status: completed.status }))
      },
      async cancelTask() {},
    }, harness.repository)
    const answer = sendRequest('admission-answer')
    answer.message.taskId = pending.id
    response = handler.sendMessage(answer, callContext())
    await entered.promise
    await harness.repository.updateTask(pending.id, task => ({
      ...taskWithState(task, TaskState.TASK_STATE_WORKING), metadata: { executed: true },
    }))
    release.resolve()
    assert.equal((await response).status.state, TaskState.TASK_STATE_COMPLETED)
    const final = await harness.repository.getTask(pending.id)
    assert.equal(final.history.at(-1).messageId, 'admission-answer')
    assert.equal(final.metadata.executed, true)
  } finally {
    release.resolve()
    await response
    await harness.close()
  }
})
