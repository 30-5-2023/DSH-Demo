import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Role, TaskState } from '@a2a-js/sdk'
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3'
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from '@a2a-js/sdk/server'
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
} from '@a2a-js/sdk/server/express'
import express from 'express'
import {
  A2AAgentClient,
  A2AFileTransfer,
  A2AFilePublications,
  createCallA2AAgentTool,
  createPublishA2AFileTool,
} from '../lib/index.js'

function deferred() { return Promise.withResolvers() }

function state(task, value, message) {
  return {
    taskId: task.id,
    contextId: task.contextId,
    status: {
      state: value,
      message,
      timestamp: new Date().toISOString(),
    },
    metadata: undefined,
  }
}

class RemoteExecutor {
  constructor() {
    this.runs = new Map()
    this.started = new Map()
    this.cancelCalls = []
    this.contextCalls = new Map()
    this.receivedParts = []
    this.inputDownloads = []
    this.base = ''
  }

  waitStarted(messageId) {
    const barrier = this.started.get(messageId) ?? deferred()
    this.started.set(messageId, barrier)
    return barrier.promise
  }

  async execute(request, events) {
    const inputPart = request.userMessage.parts[0]
    const input = inputPart.content.$case === 'text' ? inputPart.content.value : inputPart.content.value
    const command = typeof input === 'string' ? input : input.command
    this.receivedParts.push(request.userMessage.parts)
    if (command === 'inspect-files') {
      for (const part of request.userMessage.parts) {
        if (part.content?.$case !== 'url') continue
        this.inputDownloads.push(Buffer.from(await (await fetch(part.content.value)).arrayBuffer()))
      }
    }
    const submitted = {
      id: request.taskId,
      contextId: request.contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [request.userMessage],
      metadata: undefined,
    }
    events.publish(AgentEvent.task(submitted))
    events.publish(AgentEvent.statusUpdate(state(submitted, TaskState.TASK_STATE_WORKING)))
    const release = deferred()
    this.runs.set(request.taskId, { events, task: submitted, release, canceled: false })
    const started = this.started.get(request.userMessage.messageId) ?? deferred()
    this.started.set(request.userMessage.messageId, started)
    setTimeout(() => started.resolve(request.taskId), 20)
    if (command === 'hold') await release.promise
    const run = this.runs.get(request.taskId)
    if (run?.canceled) return

    if (command === 'fail') {
      const failureMessage = {
        messageId: 'remote-failure', contextId: request.contextId, taskId: request.taskId,
        role: Role.ROLE_AGENT,
        parts: [{ content: { $case: 'text', value: 'secret remote stack and full response body' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
        metadata: undefined, extensions: [], referenceTaskIds: [],
      }
      events.publish(AgentEvent.statusUpdate(state(submitted, TaskState.TASK_STATE_FAILED, failureMessage)))
      this.runs.delete(request.taskId)
      return
    }

    if (command === 'files' || command === 'unsupported') {
      if (command === 'unsupported') {
        const artifact = {
          artifactId: 'unsupported', name: 'unsupported', description: '',
          parts: [{ content: undefined, metadata: undefined, filename: '', mediaType: '' }],
          metadata: undefined, extensions: [],
        }
        events.publish(AgentEvent.artifactUpdate({
          taskId: request.taskId, contextId: request.contextId, artifact,
          append: false, lastChunk: true, metadata: undefined,
        }))
      } else {
        const replaced = {
          artifactId: 'files', name: 'files', description: '',
          parts: [{ content: { $case: 'raw', value: Buffer.from('obsolete') }, metadata: undefined, filename: 'old.bin', mediaType: 'application/octet-stream' }],
          metadata: undefined, extensions: [],
        }
        events.publish(AgentEvent.artifactUpdate({
          taskId: request.taskId, contextId: request.contextId, artifact: replaced,
          append: false, lastChunk: false, metadata: undefined,
        }))
        const replacement = {
          ...replaced,
          parts: [
            { content: { $case: 'text', value: 'remote files' }, metadata: undefined, filename: '', mediaType: 'text/plain' },
            { content: { $case: 'raw', value: Buffer.from('small-output') }, metadata: undefined, filename: 'small.txt', mediaType: 'text/plain' },
          ],
        }
        events.publish(AgentEvent.artifactUpdate({
          taskId: request.taskId, contextId: request.contextId, artifact: replacement,
          append: false, lastChunk: false, metadata: undefined,
        }))
        const appended = {
          ...replaced,
          parts: [{ content: { $case: 'url', value: `${this.base}/output-files/large` }, metadata: undefined, filename: 'large.bin', mediaType: 'application/octet-stream' }],
        }
        events.publish(AgentEvent.artifactUpdate({
          taskId: request.taskId, contextId: request.contextId, artifact: appended,
          append: true, lastChunk: false, metadata: undefined,
        }))
        const structured = {
          artifactId: 'structured', name: 'structured', description: '',
          parts: [{ content: { $case: 'data', value: { ok: true } }, metadata: undefined, filename: '', mediaType: 'application/json' }],
          metadata: undefined, extensions: [],
        }
        events.publish(AgentEvent.artifactUpdate({
          taskId: request.taskId, contextId: request.contextId, artifact: structured,
          append: false, lastChunk: true, metadata: undefined,
        }))
      }
      events.publish(AgentEvent.statusUpdate(state(submitted, TaskState.TASK_STATE_COMPLETED)))
      this.runs.delete(request.taskId)
      return
    }

    if (typeof command === 'string' && command.startsWith('uri-')) {
      const artifact = {
        artifactId: 'uri', name: 'uri', description: '',
        parts: [{
          content: { $case: 'url', value: `${this.base}/output-files/${command.slice('uri-'.length)}` },
          metadata: undefined,
          filename: 'remote.bin',
          mediaType: 'application/octet-stream',
        }],
        metadata: undefined, extensions: [],
      }
      events.publish(AgentEvent.artifactUpdate({
        taskId: request.taskId, contextId: request.contextId, artifact,
        append: false, lastChunk: true, metadata: undefined,
      }))
      events.publish(AgentEvent.statusUpdate(state(submitted, TaskState.TASK_STATE_COMPLETED)))
      this.runs.delete(request.taskId)
      return
    }

    const calls = (this.contextCalls.get(request.contextId) ?? 0) + 1
    this.contextCalls.set(request.contextId, calls)
    const acceptedJson = request.request.configuration?.acceptedOutputModes?.includes('application/json')
    const content = acceptedJson
      ? { $case: 'data', value: { ok: true, calls, input } }
      : { $case: 'text', value: command === 'large' ? 'x'.repeat(20_000) : `remote:${command}:${calls}` }
    const artifact = {
      artifactId: 'result', name: 'result', description: '',
      parts: [{ content, metadata: undefined, filename: '', mediaType: acceptedJson ? 'application/json' : 'text/plain' }],
      metadata: undefined, extensions: [],
    }
    events.publish(AgentEvent.artifactUpdate({
      taskId: request.taskId, contextId: request.contextId, artifact,
      append: false, lastChunk: true, metadata: undefined,
    }))
    events.publish(AgentEvent.statusUpdate(state(submitted, TaskState.TASK_STATE_COMPLETED)))
    this.runs.delete(request.taskId)
  }

  async cancelTask(taskId, events) {
    this.cancelCalls.push(taskId)
    const run = this.runs.get(taskId)
    if (run === undefined) return
    run.canceled = true
    events.publish(AgentEvent.statusUpdate(state({ id: taskId, contextId: run.task.contextId }, TaskState.TASK_STATE_CANCELED)))
    run.release.resolve()
    this.runs.delete(taskId)
  }
}

async function openRemote({ legacy = false } = {}) {
  const executor = new RemoteExecutor()
  const store = new InMemoryTaskStore()
  let cardFetches = 0
  const methods = []
  const app = express()
  const callerFiles = new Map()
  const largeOutput = Buffer.from('large-output-via-uri')
  const stallStarted = deferred()
  const stallClosed = deferred()
  const server = createServer(app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  executor.base = base
  app.get('/caller-files/:id', (request, response) => {
    const bytes = callerFiles.get(request.params.id)
    if (bytes === undefined) response.status(404).end()
    else response.status(200).set('content-type', 'application/octet-stream').send(bytes)
  })
  app.get('/output-files/large', (_request, response) => {
    response.status(200).set('content-type', 'application/octet-stream').send(largeOutput)
  })
  app.get('/output-files/redirect', (_request, response) => {
    response.redirect('http://unlisted.internal/file')
  })
  app.get('/output-files/oversize', (_request, response) => {
    response.status(200).set('content-type', 'application/octet-stream')
    response.write(Buffer.alloc(40, 1))
    response.end(Buffer.alloc(40, 2))
  })
  app.get('/output-files/stall', (request, response) => {
    response.status(200).set('content-type', 'application/octet-stream')
    response.write(Buffer.from('partial'))
    stallStarted.resolve()
    request.once('close', () => stallClosed.resolve())
  })
  const nativeInterfaces = [{ url: `${base}/a2a`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }]
  const legacyInterfaces = duplicateInterfacesForLegacy(nativeInterfaces, ['JSONRPC'])
    .filter(value => value.protocolVersion === '0.3')
  const card = {
    name: 'Remote Agent', description: 'Remote fixture', version: '1.0.0', provider: undefined,
    supportedInterfaces: legacy ? legacyInterfaces : nativeInterfaces,
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {}, securityRequirements: [],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [{ id: 'remote', name: 'Remote', description: 'Remote', tags: ['remote'], examples: [], inputModes: ['text/plain'], outputModes: ['text/plain'], securityRequirements: [] }],
    signatures: [],
  }
  const handler = new DefaultRequestHandler(card, store, executor)
  const legacyCompat = { enabled: true }
  app.use('/.well-known/agent-card.json', (req, _res, next) => { cardFetches += 1; next() }, agentCardHandler({
    agentCardProvider: handler,
    ...(legacy ? { legacyCompat } : {}),
  }))
  app.use('/a2a', express.json(), (req, _res, next) => {
    methods.push(req.body.method)
    next()
  }, jsonRpcHandler({
    requestHandler: handler,
    userBuilder: UserBuilder.noAuthentication,
    ...(legacy ? { legacyCompat } : {}),
  }))
  return {
    executor,
    base,
    callerFiles,
    largeOutput,
    stallStarted: stallStarted.promise,
    stallClosed: stallClosed.promise,
    cardUrl: `${base}/.well-known/agent-card.json`,
    get cardFetches() { return cardFetches },
    methods,
    async close() {
      server.close()
      await once(server, 'close')
    },
  }
}

async function openTransfer(remote, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-client-files-'))
  const objects = join(root, 'objects')
  await mkdir(objects)
  const stored = new Map()
  const paths = new Map()
  let sequence = 0
  const attachments = {
    async saveFileStream(input) {
      const chunks = []
      for await (const chunk of input.data) chunks.push(Buffer.from(chunk))
      const data = Buffer.concat(chunks)
      const name = input.name ?? 'file'
      const attachmentId = `sha256:client-${sequence++}`
      const path = join(objects, `${sequence}-${name}`)
      await writeFile(path, data)
      stored.set(attachmentId, data)
      paths.set(attachmentId, path)
      return { attachmentId, name, bytes: data.byteLength }
    },
    async *readFileStream(ref) {
      yield stored.get(ref.attachmentId)
    },
    fileHostPath(ref) {
      return paths.get(ref.attachmentId)
    },
  }
  const fileLinks = {
    async issue(file) {
      const id = String(remote.callerFiles.size)
      remote.callerFiles.set(id, stored.get(file.ref.attachmentId))
      return new URL(`/caller-files/${id}`, remote.base)
    },
  }
  const service = new A2AFileTransfer({
    attachments,
    fileUploads: { uploadStream: async () => { throw new Error('unexpected upload') } },
    maxFileBytes: 64,
    inlineFileMaxBytes: 4,
    fetchTimeoutMs: 1_000,
    maxRedirects: 1,
    publishFileAllowedRoots: [],
    fileLinks,
    ...overrides,
  })
  return {
    root,
    objects,
    service,
    async close() { await rm(root, { recursive: true, force: true }) },
  }
}

function client(overrides = {}) {
  return new A2AAgentClient({
    maxTimeoutMs: 5_000,
    maxResponseBytes: 8_192,
    maxRedirects: 2,
    cancelTimeoutMs: 1_000,
    ...overrides,
  })
}

test('calls sync and stream, refetches Card, continues context, and preserves JSON', async () => {
  const remote = await openRemote()
  try {
    const caller = client()
    const first = await caller.call({ agent_card_url: remote.cardUrl, message: 'one', stream: false }, new AbortController().signal)
    const second = await caller.call({ agent_card_url: remote.cardUrl, message: 'two', context_id: first.context_id }, new AbortController().signal)
    const structured = await caller.call({
      agent_card_url: remote.cardUrl,
      message: { command: 'json', orderId: 'WO-1' },
      accepted_output_mode: 'json',
      stream: true,
    }, new AbortController().signal)

    assert.equal(first.state, 'TASK_STATE_COMPLETED')
    assert.equal(first.output, 'remote:one:1')
    assert.equal(second.context_id, first.context_id)
    assert.equal(second.output, 'remote:two:2')
    assert.deepEqual(structured.output, { ok: true, calls: 1, input: { command: 'json', orderId: 'WO-1' } })
    assert.equal(remote.cardFetches, 3)
  } finally {
    await remote.close()
  }
})

test('uses v0.3 methods for legacy Cards without downgrading v1 peers', async () => {
  const legacy = await openRemote({ legacy: true })
  const modern = await openRemote()
  try {
    const caller = client()
    const sent = await caller.call({
      agent_card_url: legacy.cardUrl,
      message: 'legacy-sync',
      stream: false,
    }, new AbortController().signal)
    const streamed = await caller.call({
      agent_card_url: legacy.cardUrl,
      message: 'legacy-stream',
      context_id: sent.context_id,
      stream: true,
    }, new AbortController().signal)
    const native = await caller.call({
      agent_card_url: modern.cardUrl,
      message: 'modern',
      stream: false,
    }, new AbortController().signal)

    assert.equal(sent.output, 'remote:legacy-sync:1')
    assert.equal(streamed.output, 'remote:legacy-stream:2')
    assert.equal(native.output, 'remote:modern:1')
    assert.deepEqual(legacy.methods, ['message/send', 'message/stream'])
    assert.deepEqual(modern.methods, ['SendMessage'])
  } finally {
    await legacy.close()
    await modern.close()
  }
})

test('sends local files after the message as v0.3 raw and URL Parts', async () => {
  const remote = await openRemote({ legacy: true })
  const transfer = await openTransfer(remote)
  try {
    await writeFile(join(transfer.root, 'small.txt'), '1234')
    await writeFile(join(transfer.root, 'large.bin'), '12345')
    const caller = client({ fileTransfer: transfer.service })
    const result = await caller.call({
      agent_card_url: remote.cardUrl,
      message: 'inspect-files',
      files: [
        { path: 'small.txt', name: 'tiny.txt', mime_type: 'text/plain' },
        { path: 'large.bin', name: 'payload.bin', mime_type: 'application/octet-stream' },
      ],
      stream: false,
    }, new AbortController().signal, transfer.root)

    assert.equal(result.state, 'TASK_STATE_COMPLETED')
    const parts = remote.executor.receivedParts.at(-1)
    assert.deepEqual(parts.map(part => part.content.$case), ['text', 'raw', 'url'])
    assert.deepEqual(parts.slice(1).map(part => [part.filename, part.mediaType]), [
      ['tiny.txt', 'text/plain'],
      ['payload.bin', 'application/octet-stream'],
    ])
    assert.deepEqual(Buffer.from(parts[1].content.value), Buffer.from('1234'))
    assert.deepEqual(remote.executor.inputDownloads, [Buffer.from('12345')])
    assert.deepEqual(remote.methods, ['message/send'])
  } finally {
    await transfer.close()
    await remote.close()
  }
})

test('materializes final remote file Parts in Artifact order while preserving text and JSON', async () => {
  const remote = await openRemote({ legacy: true })
  const transfer = await openTransfer(remote)
  try {
    const result = await client({ fileTransfer: transfer.service }).call({
      agent_card_url: remote.cardUrl,
      message: 'files',
      stream: true,
    }, new AbortController().signal)

    assert.deepEqual(result.output, ['remote files', { ok: true }])
    assert.deepEqual(result.files.map(file => ({ ...file, path: undefined })), [
      { path: undefined, name: 'small.txt', mime_type: 'text/plain', bytes: 12, artifact_id: 'files' },
      { path: undefined, name: 'large.bin', mime_type: 'application/octet-stream', bytes: remote.largeOutput.byteLength, artifact_id: 'files' },
    ])
    assert.deepEqual(Buffer.from(await readFile(result.files[0].path)), Buffer.from('small-output'))
    assert.deepEqual(Buffer.from(await readFile(result.files[1].path)), remote.largeOutput)
  } finally {
    await transfer.close()
    await remote.close()
  }
})

test('rejects local files without a workspace and unsupported remote Parts', async () => {
  const remote = await openRemote()
  const transfer = await openTransfer(remote)
  try {
    await assert.rejects(
      client({ fileTransfer: transfer.service }).call({
        agent_card_url: remote.cardUrl,
        message: 'inspect-files',
        files: [{ path: 'missing.bin' }],
      }, new AbortController().signal),
      error => error?.code === 'A2A_CALL_WORKSPACE_REQUIRED',
    )
    await assert.rejects(
      client({ fileTransfer: transfer.service }).call({
        agent_card_url: remote.cardUrl,
        message: 'unsupported',
      }, new AbortController().signal),
      error => error?.code === 'A2A_UNSUPPORTED_PART',
    )
  } finally {
    await transfer.close()
    await remote.close()
  }
})

test('rejects unsafe, oversized, and canceled remote URI outputs without partial files', async () => {
  const remote = await openRemote()
  const transfer = await openTransfer(remote)
  const caller = client({ fileTransfer: transfer.service })
  try {
    await assert.rejects(
      caller.call({ agent_card_url: remote.cardUrl, message: 'uri-redirect' }, new AbortController().signal),
      error => error?.code === 'A2A_FILE_URI_REJECTED',
    )
    await assert.rejects(
      caller.call({ agent_card_url: remote.cardUrl, message: 'uri-oversize' }, new AbortController().signal),
      error => error?.code === 'A2A_FILE_TOO_LARGE',
    )

    const controller = new AbortController()
    const stalled = caller.call({ agent_card_url: remote.cardUrl, message: 'uri-stall' }, controller.signal)
    await remote.stallStarted
    controller.abort(new Error('stop materialization'))
    await assert.rejects(stalled, error => error?.code === 'A2A_FETCH_ABORTED')
    await remote.stallClosed
    assert.deepEqual(await readdir(transfer.objects), [])
  } finally {
    await transfer.close()
    await remote.close()
  }
})

test('returns safe remote failure and rejects oversized responses', async () => {
  const remote = await openRemote()
  try {
    const caller = client()
    const failed = await caller.call({ agent_card_url: remote.cardUrl, message: 'fail' }, new AbortController().signal)
    assert.equal(failed.state, 'TASK_STATE_FAILED')
    assert.deepEqual(failed.failure, {
      code: 'A2A_REMOTE_FAILED',
      message: 'Remote A2A task ended in TASK_STATE_FAILED.',
    })
    assert.doesNotMatch(JSON.stringify(failed), /secret remote stack|full response body/i)

    await assert.rejects(
      client({ maxResponseBytes: 4_096 }).call({ agent_card_url: remote.cardUrl, message: 'large' }, new AbortController().signal),
      /byte limit|too large/i,
    )
  } finally {
    await remote.close()
  }
})

test('handles controlled timeout and caller cancellation with one bounded remote CancelTask', async () => {
  const remote = await openRemote()
  try {
    const deadlines = []
    const caller = client({
      deadlineFactory() {
        const controller = new AbortController()
        deadlines.push(controller)
        return { signal: controller.signal, close() {} }
      },
    })
    const timed = caller.call({ agent_card_url: remote.cardUrl, message: 'hold', timeout_ms: 500 }, new AbortController().signal)
    await remote.executor.waitStarted('a2a-outbound-1')
    deadlines[0].abort(new Error('controlled timeout'))
    await assert.rejects(timed, /timed out/i)
    assert.equal(remote.executor.cancelCalls.length, 1)

    const controller = new AbortController()
    const canceled = caller.call({ agent_card_url: remote.cardUrl, message: 'hold' }, controller.signal)
    await remote.executor.waitStarted('a2a-outbound-2')
    controller.abort(new Error('caller stopped'))
    await assert.rejects(canceled, /canceled/i)
    assert.equal(remote.executor.cancelCalls.length, 2)
  } finally {
    await remote.close()
  }
})

test('defines the file-capable call tool schema and safe presentations', () => {
  const caller = { call: async () => ({ context_id: 'ctx', task_id: 'task', state: 'TASK_STATE_COMPLETED', output: 'done' }) }
  const tool = createCallA2AAgentTool(caller, 5_000)
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
    'accepted_output_mode', 'agent_card_url', 'context_id', 'files', 'message', 'stream', 'timeout_ms',
  ])
  assert.deepEqual(Object.keys(tool.output.schema.properties).sort(), [
    'context_id', 'failure', 'files', 'output', 'state', 'task_id',
  ])
  assert.doesNotMatch(JSON.stringify(tool.parameters), /authorization|token|credential/i)
  const args = { agent_card_url: 'http://agent.internal/.well-known/agent-card.json', message: 'work' }
  assert.deepEqual(tool.presentCall(args), {
    card: 'generic', title: 'call_a2a_agent', rawInput: args.agent_card_url,
  })
  assert.deepEqual(tool.presentResult(args, { content: [], isError: false }), { card: 'generic' })
  const rendered = tool.output.render(args, { context_id: 'ctx', task_id: 'task', state: 'TASK_STATE_COMPLETED', output: 'done' })
  assert.match(rendered[0].text, /ctx/)
  assert.match(rendered[0].text, /task/)
  assert.match(rendered[0].text, /TASK_STATE_COMPLETED/)
  assert.match(rendered[0].text, /done/)
  assert.doesNotMatch(rendered[0].text, /stack|response body/i)
})

test('passes call files and the Session workspace without rendering bytes', async () => {
  const calls = []
  const caller = { call: async (...args) => { calls.push(args); return { state: 'TASK_STATE_COMPLETED', files: [] } } }
  const tool = createCallA2AAgentTool(caller, 5_000)
  const controller = new AbortController()
  const args = {
    agent_card_url: 'http://agent.internal/.well-known/agent-card.json',
    message: 'work',
    files: [{ path: 'reports/result.bin', name: 'result.bin', mime_type: 'application/octet-stream' }],
  }
  const result = await tool.execute(args, {
    signal: controller.signal,
    agent: { session: { header: { cwd: 'C:\\workspace' } } },
  })
  assert.deepEqual(calls[0], [args, controller.signal, 'C:\\workspace'])
  assert.doesNotMatch(tool.output.render(args, result)[0].text, /base64|content|data/i)
})

test('defines a path-based publish tool with metadata-only output', () => {
  const tool = createPublishA2AFileTool(new A2AFilePublications(), {
    snapshotLocal: async () => { throw new Error('not executed') },
  })
  assert.equal(tool.name, 'publish_a2a_file')
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['mime_type', 'name', 'path'])
  assert.deepEqual(Object.keys(tool.output.schema.properties).sort(), [
    'attachment_id', 'bytes', 'mime_type', 'name',
  ])
  assert.doesNotMatch(JSON.stringify(tool.output.schema), /path|data|content|token|url/i)
  assert.equal(tool.presentCall({ path: 'generated/report.txt', name: '../report.txt' }).rawInput, 'report.txt')
  assert.deepEqual(tool.presentResult({ path: 'generated/report.txt' }, { content: [], isError: false }), { card: 'generic' })
})
