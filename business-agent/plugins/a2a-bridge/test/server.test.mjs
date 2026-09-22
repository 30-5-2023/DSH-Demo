import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Role, TaskState } from '@a2a-js/sdk'
import { ClientFactory } from '@a2a-js/sdk/client'
import { AgentEvent } from '@a2a-js/sdk/server'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import {
  A2AFileLinks,
  A2AMessageId,
  A2ATaskId,
  BridgeRequestHandler,
  DomainTaskStore,
  StorageDomainA2ARepository,
  StorageDomainA2AFileLinkRepository,
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
    this.executions = 0
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
    this.executions += 1
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
    maxRequestBytes: 65_540,
    inlineFileMaxBytes: 1,
    maxResponseBytes: 4_096,
    maxConcurrentContexts: 4,
    ...overrides,
  }
}

async function openHarness({ token, dedicated = false, download = false, now, downloadBody } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-server-'))
  const ctx = new Context()
  const webFiber = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' })
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  const repository = await StorageDomainA2ARepository.open(facility)
  const fileLinkRepository = download
    ? await StorageDomainA2AFileLinkRepository.open(facility)
    : undefined
  const taskStore = new ObservedTaskStore(repository)
  const executor = new ScriptedExecutor(repository, taskStore)
  const env = token === undefined ? {} : { SERVER_TEST_TOKEN: token }
  const sharedBaseUrl = `http://127.0.0.1:${ctx.webServer.port}`
  const baseUrl = dedicated ? 'http://127.0.0.1:0' : sharedBaseUrl
  const resolved = resolveConfig(rawConfig(baseUrl, token === undefined ? {} : { bearerTokenEnv: 'SERVER_TEST_TOKEN' }), {
    host: '127.0.0.1', port: ctx.webServer.port, env,
  })
  const config = dedicated
    ? { ...resolved, listener: { host: '127.0.0.1', port: 0 } }
    : resolved
  const handler = new BridgeRequestHandler(config.agentCard, taskStore, executor, repository)
  let fileLinks
  const bodies = new Map()
  const downloads = fileLinkRepository === undefined ? undefined : {
    async handle(rawToken, method, signal) {
      const result = await fileLinks.resolve(rawToken)
      if (result.kind === 'missing') return { status: 404 }
      if (result.kind === 'expired') return { status: 410 }
      return {
        status: 200,
        record: result.record,
        ...(method === 'GET'
          ? {
              body: downloadBody === undefined
                ? (async function* () { yield bodies.get(result.record.ref.attachmentId) })()
                : downloadBody(result.record, signal),
            }
          : {}),
      }
    },
  }
  const server = await createA2AServer(ctx, config, handler, downloads)
  if (fileLinkRepository !== undefined) {
    fileLinks = new A2AFileLinks(fileLinkRepository, {
      publicBaseUrl: new URL('/', server.cardUrl),
      route: config.route,
      retentionMs: 60_000,
      ...(now === undefined ? {} : { now }),
    })
  }
  return {
    baseUrl: new URL('/', server.cardUrl).href.replace(/\/$/, ''),
    sharedBaseUrl,
    config,
    executor,
    fileLinks,
    bodies,
    repository,
    server,
    async close() {
      await server.close()
      await fileLinkRepository?.close()
      await repository.close()
      await backend.close()
      await webFiber.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function legacyMessage(messageId, text) {
  return {
    role: 'user',
    messageId,
    parts: [{ kind: 'text', text }],
  }
}

function legacyFileMessage(messageId, file) {
  return {
    role: 'user',
    messageId,
    parts: [{ kind: 'file', file }],
  }
}

async function legacyRpc(url, method, params, id = method) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  assert.equal(response.status, 200)
  return response.json()
}

async function occupyLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))),
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
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(66_000) }),
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

test('negotiates legacy Cards and dispatches v0.3 JSON-RPC methods', async () => {
  const harness = await openHarness()
  try {
    const legacyCard = await (await fetch(harness.server.cardUrl)).json()
    assert.equal(legacyCard.protocolVersion, '0.3')
    assert.equal(legacyCard.url, harness.server.rpcUrl.href)
    assert.equal(legacyCard.preferredTransport, 'JSONRPC')

    const v1Card = await (await fetch(harness.server.cardUrl, { headers: { 'a2a-version': '1.0' } })).json()
    assert.deepEqual(v1Card.supportedInterfaces.map(value => value.protocolVersion), ['1.0', '0.3'])

    const sent = await legacyRpc(harness.server.rpcUrl, 'message/send', {
      message: legacyMessage('legacy-sync', 'legacy-sync'),
      configuration: { blocking: true, acceptedOutputModes: ['text/plain'] },
    })
    assert.equal(sent.result.status.state, 'completed')
    assert.equal(sent.result.artifacts[0].parts[0].text, 'reply:legacy-sync')

    const fetched = await legacyRpc(harness.server.rpcUrl, 'tasks/get', { id: sent.result.id })
    assert.equal(fetched.result.id, sent.result.id)

    const streamResponse = await fetch(harness.server.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'legacy-stream', method: 'message/stream',
        params: { message: legacyMessage('legacy-stream', 'legacy-stream') },
      }),
    })
    assert.equal(streamResponse.status, 200)
    const streamed = (await streamResponse.text())
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice('data: '.length)).result)
    assert.deepEqual(streamed.map(value => value.kind), ['task', 'status-update', 'artifact-update', 'status-update'])
    assert.equal(streamed.at(-1).status.state, 'completed')

    const cancelStream = fetch(harness.server.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'legacy-cancel-stream', method: 'message/stream',
        params: { message: legacyMessage('legacy-cancel', 'hold-cancel') },
      }),
    })
    const started = await harness.executor.waitStarted('legacy-cancel')
    const canceled = await legacyRpc(harness.server.rpcUrl, 'tasks/cancel', { id: started.taskId })
    assert.equal(canceled.result.status.state, 'canceled')
    await cancelStream

    const unsupported = await legacyRpc(harness.server.rpcUrl, 'tasks/pushNotificationConfig/get', {
      id: sent.result.id,
      pushNotificationConfigId: 'missing',
    })
    assert.equal(unsupported.error.code, -32004)
  } finally {
    await harness.close()
  }
})

test('rejects non-canonical v0.3 base64 before dispatch and accepts canonical empty or non-empty bytes', async () => {
  const harness = await openHarness()
  try {
    const before = harness.executor.executions
    for (const [id, file] of [
      ['non-canonical', { bytes: 'YQ', name: 'bad.bin', mimeType: 'application/octet-stream' }],
      ['conflicting', { bytes: 'YQ==', uri: 'http://files.internal/file', name: 'bad.bin' }],
      ['missing', { name: 'bad.bin' }],
    ]) {
      const invalid = await legacyRpc(harness.server.rpcUrl, 'message/send', {
        message: legacyFileMessage(`legacy-file-${id}`, file),
        configuration: { blocking: true },
      }, `legacy-file-${id}`)
      assert.equal(invalid.error.code, -32602)
    }
    assert.equal(harness.executor.executions, before)

    for (const [id, bytes] of [['empty', ''], ['one-byte', 'YQ==']]) {
      const accepted = await legacyRpc(harness.server.rpcUrl, 'message/send', {
        message: legacyFileMessage(`legacy-file-${id}`, {
          bytes,
          name: `${id}.bin`,
          mimeType: 'application/octet-stream',
        }),
        configuration: { blocking: true },
      }, `legacy-file-${id}`)
      assert.equal(accepted.result.status.state, 'completed')
    }
    assert.equal(harness.executor.executions, before + 2)
  } finally {
    await harness.close()
  }
})

test('dedicated listener exposes only A2A routes and leaves shared Web routes private', async () => {
  const harness = await openHarness({ dedicated: true })
  try {
    assert.notEqual(harness.server.cardUrl.port, '0')
    assert.equal((await fetch(harness.server.cardUrl)).status, 200)
    assert.equal((await fetch(new URL('/unrelated', harness.server.cardUrl))).status, 404)
    assert.equal((await fetch(new URL('/.well-known/agent-card.json', harness.sharedBaseUrl))).status, 404)
    const sent = await legacyRpc(harness.server.rpcUrl, 'message/send', {
      message: legacyMessage('dedicated-sync', 'dedicated-sync'),
      configuration: { blocking: true },
    })
    assert.equal(sent.result.status.state, 'completed')
  } finally {
    await harness.close()
  }
})

test('dedicated listener serves opaque file links with exact download semantics', async () => {
  let clock = new Date('2026-09-22T00:00:00.000Z')
  const harness = await openHarness({
    dedicated: true,
    download: true,
    now: () => clock,
  })
  try {
    const bytes = Buffer.from('download bytes')
    const attachmentId = AttachmentId('sha256:server-download')
    harness.bodies.set(attachmentId, bytes)
    const url = await harness.fileLinks.issue({
      ref: { attachmentId, name: 'résumé.txt', bytes: bytes.byteLength },
      mediaType: 'text/plain',
    }, A2ATaskId('download-task'))

    const head = await fetch(url, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-type'), 'text/plain')
    assert.equal(head.headers.get('content-length'), String(bytes.byteLength))
    assert.equal(
      head.headers.get('content-disposition'),
      'attachment; filename="r_sum_.txt"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.txt',
    )
    assert.equal(head.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(head.headers.get('accept-ranges'), 'none')
    assert.equal(await head.text(), '')

    const get = await fetch(url)
    assert.equal(get.status, 200)
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes)

    const post = await fetch(url, { method: 'POST' })
    assert.equal(post.status, 405)
    assert.equal(post.headers.get('allow'), 'GET, HEAD')
    const range = await fetch(url, { headers: { range: 'bytes=0-1' } })
    assert.equal(range.status, 416)
    assert.equal(range.headers.get('accept-ranges'), 'none')
    assert.equal((await fetch(new URL(`${harness.config.route}/files/${'A'.repeat(43)}`, url))).status, 404)

    clock = new Date('2026-09-22T00:01:00.000Z')
    assert.equal((await fetch(url)).status, 410)
  } finally {
    await harness.close()
  }
})

test('shared listener does not expose hosted-file routes', async () => {
  const harness = await openHarness({ download: true })
  try {
    const bytes = Buffer.from('private')
    const attachmentId = AttachmentId('sha256:shared-private')
    harness.bodies.set(attachmentId, bytes)
    const url = await harness.fileLinks.issue({
      ref: { attachmentId, name: 'private.bin', bytes: bytes.byteLength },
      mediaType: 'application/octet-stream',
    }, A2ATaskId('shared-private-task'))
    assert.equal((await fetch(url)).status, 404)
  } finally {
    await harness.close()
  }
})

test('disconnecting a dedicated download aborts its stream and lets close settle', async () => {
  const aborted = deferred()
  const harness = await openHarness({
    dedicated: true,
    download: true,
    downloadBody: (_record, signal) => (async function* () {
      yield Buffer.from('first')
      if (!signal.aborted) {
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      }
      aborted.resolve(signal.reason)
    })(),
  })
  try {
    const attachmentId = AttachmentId('sha256:disconnect-download')
    const url = await harness.fileLinks.issue({
      ref: { attachmentId, name: 'large.bin', bytes: 10 },
      mediaType: 'application/octet-stream',
    }, A2ATaskId('disconnect-download-task'))
    const response = await fetch(url)
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.equal(first.done, false)
    assert.deepEqual(Buffer.from(first.value), Buffer.from('first'))

    const closing = harness.server.close()
    await reader.cancel()
    assert.match(String(await aborted.promise), /client disconnected/)
    await closing
  } finally {
    await harness.close()
  }
})

test('dedicated listener rejects new connections while close waits for an admitted stream', async () => {
  const harness = await openHarness({ dedicated: true })
  try {
    assert.notEqual(harness.server.cardUrl.port, '0')
    const stream = fetch(harness.server.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'close-stream', method: 'message/stream',
        params: { message: legacyMessage('close-stream', 'hold-cancel') },
      }),
    })
    await harness.executor.waitStarted('close-stream')
    let closed = false
    const closing = harness.server.close().then(() => { closed = true })
    await assert.rejects(fetch(harness.server.cardUrl))
    assert.equal(closed, false)
    harness.executor.release('close-stream')
    await stream
    await closing
    assert.equal(closed, true)
  } finally {
    await harness.close()
  }
})

test('dedicated bind failure leaves the shared Web Server without A2A routes', async () => {
  const occupied = await occupyLoopbackPort()
  const harness = await openHarness()
  try {
    const config = {
      ...harness.config,
      listener: { host: '127.0.0.1', port: occupied.port },
    }
    const handler = {
      getAgentCard: async () => config.agentCard,
    }
    await assert.rejects(createA2AServer(new Context(), config, handler), /EADDRINUSE|address already in use/i)
    assert.equal((await fetch(new URL('/unrelated', harness.sharedBaseUrl))).status, 404)
  } finally {
    await occupied.close()
    await harness.close()
  }
})
