import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Role, TaskState } from '@a2a-js/sdk'
import { ClientFactory } from '@a2a-js/sdk/client'
import { AgentEvent } from '@a2a-js/sdk/server'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import {
  A2AMessageId,
  BridgeRequestHandler,
  DomainTaskStore,
  StorageDomainA2ARepository,
  createA2AServer,
  resolveConfig,
} from '../lib/index.js'

function deferred() {
  return Promise.withResolvers()
}

function input(messageId, text, contextId = '') {
  return {
    tenant: '',
    message: {
      messageId,
      contextId,
      taskId: '',
      role: Role.ROLE_USER,
      parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
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

function stateTask(task, state, artifacts = task.artifacts) {
  return { ...task, artifacts, status: { state, message: undefined, timestamp: new Date().toISOString() } }
}

class ObservedTaskStore extends DomainTaskStore {
  constructor(repository) {
    super(repository)
    this.working = new Map()
  }

  waitWorking(taskId) {
    const barrier = this.working.get(taskId) ?? deferred()
    this.working.set(taskId, barrier)
    return barrier.promise
  }

  async save(task, context) {
    await super.save(task, context)
    if (task.status?.state === TaskState.TASK_STATE_WORKING) {
      const barrier = this.working.get(task.id) ?? deferred()
      this.working.set(task.id, barrier)
      barrier.resolve()
    }
  }
}

class ScriptedExecutor {
  constructor(repository, taskStore) {
    this.repository = repository
    this.taskStore = taskStore
    this.runs = new Map()
    this.byMessage = new Map()
    this.finished = new Map()
  }

  allowNewContext() {}

  waitStarted(messageId) {
    const run = this.byMessage.get(messageId)
    if (run !== undefined) return run.started.promise
    const started = deferred()
    this.byMessage.set(messageId, { started })
    return started.promise
  }

  release(messageId) {
    const run = this.byMessage.get(messageId)
    assert.ok(run?.release, `executor must have started ${messageId}`)
    run.release.resolve()
  }

  waitFinished(messageId) {
    const barrier = this.finished.get(messageId) ?? deferred()
    this.finished.set(messageId, barrier)
    return barrier.promise
  }

  async execute(request, events) {
    const text = request.userMessage.parts[0].content.value
    const messageId = request.userMessage.messageId
    const message = { ...request.userMessage, taskId: request.taskId, contextId: request.contextId }
    const submitted = stateTask({
      id: request.taskId,
      contextId: request.contextId,
      status: undefined,
      artifacts: [],
      history: [message],
      metadata: undefined,
    }, TaskState.TASK_STATE_SUBMITTED)
    const release = deferred()
    const existing = this.byMessage.get(messageId)
    const started = existing?.started ?? deferred()
    const run = { task: submitted, events, release, started, canceled: false }
    this.byMessage.set(messageId, run)
    this.runs.set(request.taskId, run)

    try {
      await this.repository.saveTask(submitted, A2AMessageId(messageId))
      events.publish(AgentEvent.task(submitted))
      const working = stateTask(submitted, TaskState.TASK_STATE_WORKING)
      run.task = working
      await this.repository.saveTask(working)
      events.publish(AgentEvent.statusUpdate({ taskId: working.id, contextId: working.contextId, status: working.status, metadata: undefined }))
      started.resolve({ taskId: request.taskId, contextId: request.contextId })
      await this.taskStore.waitWorking(request.taskId)
      if (text === 'hold-cancel' || text === 'disconnect') await release.promise
      if (run.canceled) return

      const artifact = {
        artifactId: 'result', name: 'result', description: '',
        parts: [{ content: { $case: 'text', value: `reply:${text}` }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
        metadata: undefined, extensions: [],
      }
      const completed = stateTask(working, TaskState.TASK_STATE_COMPLETED, [artifact])
      run.task = completed
      await this.repository.saveTask(completed)
      events.publish(AgentEvent.artifactUpdate({
        taskId: completed.id, contextId: completed.contextId, artifact,
        append: false, lastChunk: true, metadata: undefined,
      }))
      events.publish(AgentEvent.statusUpdate({ taskId: completed.id, contextId: completed.contextId, status: completed.status, metadata: undefined }))
    } finally {
      this.runs.delete(request.taskId)
      const finished = this.finished.get(messageId) ?? deferred()
      this.finished.set(messageId, finished)
      finished.resolve()
    }
  }

  async cancelTask(taskId, events) {
    const run = this.runs.get(taskId)
    assert.ok(run, `task ${taskId} must be active`)
    run.canceled = true
    const canceled = stateTask(run.task, TaskState.TASK_STATE_CANCELED)
    run.task = canceled
    await this.repository.saveTask(canceled)
    events.publish(AgentEvent.statusUpdate({ taskId: canceled.id, contextId: canceled.contextId, status: canceled.status, metadata: undefined }))
    run.release.resolve()
  }
}

function rawConfig(baseUrl, overrides = {}) {
  return {
    route: '/a2a',
    publicBaseUrl: baseUrl,
    agent: {
      name: 'Server Test Agent',
      description: 'A2A server integration fixture',
      version: '1.0.0',
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [{ id: 'test', name: 'Test', description: 'Test requests', tags: ['test'] }],
    },
    requestTimeoutMs: 60_000,
    outboundTimeoutMs: 60_000,
    maxRequestBytes: 4_096,
    maxResponseBytes: 4_096,
    maxConcurrentContexts: 4,
    ...overrides,
  }
}

async function openHarness({ token } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-server-'))
  const ctx = new Context()
  const webFiber = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' })
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  const repository = await StorageDomainA2ARepository.open(facility)
  const taskStore = new ObservedTaskStore(repository)
  const executor = new ScriptedExecutor(repository, taskStore)
  const env = token === undefined ? {} : { SERVER_TEST_TOKEN: token }
  const baseUrl = `http://127.0.0.1:${ctx.webServer.port}`
  const config = resolveConfig(rawConfig(baseUrl, token === undefined ? {} : { bearerTokenEnv: 'SERVER_TEST_TOKEN' }), {
    host: '127.0.0.1', port: ctx.webServer.port, env,
  })
  const handler = new BridgeRequestHandler(config.agentCard, taskStore, executor, repository)
  const server = createA2AServer(ctx, config, handler)
  return {
    baseUrl,
    config,
    executor,
    repository,
    server,
    async close() {
      await server.close()
      await repository.close()
      await backend.close()
      await webFiber.dispose()
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

test('serves discovery, sync, streaming, get, cancel, and strict HTTP admission', async () => {
  const harness = await openHarness()
  try {
    const cardResponse = await fetch(harness.server.cardUrl)
    assert.equal(cardResponse.status, 200)
    assert.equal((await cardResponse.json()).name, 'Server Test Agent')
    const client = await new ClientFactory().createFromUrl(harness.baseUrl)

    const sync = await client.sendMessage(input('server-sync', 'sync'))
    assert.equal(sync.status.state, TaskState.TASK_STATE_COMPLETED)
    assert.equal(sync.artifacts[0].parts[0].content.value, 'reply:sync')
    const fetched = await client.getTask({ tenant: '', id: sync.id, historyLength: undefined })
    assert.equal(fetched.id, sync.id)

    const streamed = await collect(client.sendMessageStream(input('server-stream', 'stream')))
    assert.deepEqual(streamed.map(value => value.payload.$case), ['task', 'statusUpdate', 'artifactUpdate', 'statusUpdate'])
    assert.equal(streamed.at(-1).payload.value.status.state, TaskState.TASK_STATE_COMPLETED)

    const cancelStream = client.sendMessageStream(input('server-cancel', 'hold-cancel'))
    let cancelTaskId
    for await (const value of cancelStream) {
      if (value.payload.$case === 'task') cancelTaskId = value.payload.value.id
      if (value.payload.$case === 'statusUpdate' && value.payload.value.status.state === TaskState.TASK_STATE_WORKING) break
    }
    assert.ok(cancelTaskId)
    const canceled = await client.cancelTask({ tenant: '', id: cancelTaskId })
    assert.equal(canceled.status.state, TaskState.TASK_STATE_CANCELED)

    assert.equal((await fetch(harness.server.rpcUrl, { method: 'GET' })).status, 405)
    assert.equal((await fetch(harness.server.cardUrl, { method: 'POST' })).status, 405)
    assert.equal((await fetch(harness.server.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
    })).status, 400)
    assert.equal((await fetch(harness.server.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(5_000) }),
    })).status, 413)
  } finally {
    await harness.close()
  }
})

test('disconnecting SSE does not cancel execution and GetTask returns the final Artifact', async () => {
  const harness = await openHarness()
  try {
    const client = await new ClientFactory().createFromUrl(harness.baseUrl)
    const stream = client.sendMessageStream(input('server-disconnect', 'disconnect'))
    let taskId
    while (true) {
      const next = await stream.next()
      assert.equal(next.done, false)
      if (next.value.payload.$case === 'task') taskId = next.value.payload.value.id
      if (next.value.payload.$case === 'statusUpdate' && next.value.payload.value.status.state === TaskState.TASK_STATE_WORKING) break
    }
    await stream.return()
    harness.executor.release('server-disconnect')
    await harness.executor.waitFinished('server-disconnect')

    const task = await client.getTask({ tenant: '', id: taskId, historyLength: undefined })
    assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED)
    assert.equal(task.artifacts[0].parts[0].content.value, 'reply:disconnect')
  } finally {
    await harness.close()
  }
})

test('keeps discovery public and requires an exact Bearer token only on RPC', async () => {
  const harness = await openHarness({ token: 'same-length-secret' })
  try {
    assert.equal((await fetch(harness.server.cardUrl)).status, 200)
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'auth', method: 'GetTask', params: { tenant: '', id: 'missing' } })
    for (const authorization of [undefined, 'Bearer short', 'Bearer same-length-secrex']) {
      const response = await fetch(harness.server.rpcUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'a2a-version': '1.0',
          ...(authorization === undefined ? {} : { authorization }),
        },
        body,
      })
      assert.equal(response.status, 401)
      assert.equal(response.headers.get('www-authenticate'), 'Bearer')
    }
    const accepted = await fetch(harness.server.rpcUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'a2a-version': '1.0',
        authorization: 'Bearer same-length-secret',
      },
      body,
    })
    assert.equal(accepted.status, 200)
    assert.equal((await accepted.json()).error.code, -32001)
  } finally {
    await harness.close()
  }
})
