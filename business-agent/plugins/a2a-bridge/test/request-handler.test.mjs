import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Role, TaskState } from '@a2a-js/sdk'
import { TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors'
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
  getTask(taskId) { return this.delegate.getTask(taskId) }
  getTaskByMessageId(messageId) { return this.delegate.getTaskByMessageId(messageId) }
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
