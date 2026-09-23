import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Role, TaskState } from '@a2a-js/sdk'
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server'
import {
  A2AAgentClient,
  A2AFileTransfer,
  createA2AHttpApplication,
  resolveConfig,
} from '../lib/index.js'

const execFileAsync = promisify(execFile)
const python = process.env.DSH_A2A_PYTHON032
const peer = fileURLToPath(new URL('../../../tests/fixtures/a2a-python-v032-peer.py', import.meta.url))
const MIB = 1024 * 1024

function payload(size, marker) {
  const pattern = Buffer.from(marker)
  return Buffer.concat(Array(Math.ceil(size / pattern.byteLength)).fill(pattern)).subarray(0, size)
}

function digest(data) {
  return createHash('sha256').update(data).digest('hex')
}

const pythonInputInline = payload(MIB, 'python-inline-')
const pythonInputUri = payload(MIB + 1, 'python-uri-')
const javascriptOutputInline = payload(MIB, 'javascript-output-inline-')
const javascriptOutputUri = payload(MIB + 1, 'javascript-output-uri-')
const javascriptInputInline = payload(MIB, 'javascript-inline-')
const javascriptInputUri = payload(MIB + 1, 'javascript-uri-')
const pythonOutputInline = payload(MIB, 'python-output-inline-')
const pythonOutputUri = payload(MIB + 1, 'python-output-uri-')

function deferred() { return Promise.withResolvers() }

async function bounded(promise, label, timeoutMs = 10_000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function status(task, state) {
  return {
    taskId: task.id,
    contextId: task.contextId,
    status: { state, message: undefined, timestamp: new Date().toISOString() },
    metadata: undefined,
  }
}

class PythonClientExecutor {
  constructor(baseUrl) {
    this.baseUrl = baseUrl
    this.runs = new Map()
  }

  async execute(request, events) {
    const content = request.userMessage.parts[0].content
    const text = content.$case === 'text' ? content.value : undefined
    const task = {
      id: request.taskId,
      contextId: request.contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [request.userMessage],
      metadata: undefined,
    }
    events.publish(AgentEvent.task(task))
    events.publish(AgentEvent.statusUpdate(status(task, TaskState.TASK_STATE_WORKING)))
    const release = deferred()
    const run = { release, canceled: false, task, events }
    this.runs.set(task.id, run)
    if (text === 'python-question') {
      const question = {
        ...request.userMessage, role: Role.ROLE_AGENT, messageId: 'javascript-question',
        parts: [
          { content: { $case: 'text', value: 'Select the environment' }, filename: '', mediaType: 'text/plain', metadata: undefined },
          { content: { $case: 'data', value: {
            schema: 'urn:deepseek-harness:a2a:input-required:v1', questions: [
              { id: 'environment', question: 'Select the environment', options: [{ label: 'Test' }, { label: 'Production' }] },
            ],
          } }, filename: '', mediaType: 'application/json', metadata: undefined },
        ],
      }
      events.publish(AgentEvent.statusUpdate({
        ...status(task, TaskState.TASK_STATE_INPUT_REQUIRED),
        status: { state: TaskState.TASK_STATE_INPUT_REQUIRED, message: question, timestamp: new Date().toISOString() },
      }))
      this.runs.delete(task.id)
      return
    }
    if (text === 'python-cancel') await release.promise
    if (run.canceled) return
    let parts
    if (text === 'python-files') {
      const inputParts = []
      for (const part of request.userMessage.parts) {
        const content = part.content
        if (content.$case === 'text') inputParts.push({ kind: 'text', text: content.value })
        else if (content.$case === 'data') inputParts.push({ kind: 'data', data: content.value })
        else if (content.$case === 'raw') {
          const bytes = Buffer.from(content.value)
          inputParts.push({
            kind: 'file', class: 'FileWithBytes', name: part.filename, mimeType: part.mediaType,
            bytes: bytes.byteLength, sha256: digest(bytes),
          })
        } else if (content.$case === 'url') {
          const bytes = Buffer.from(await (await fetch(content.value, { signal: AbortSignal.timeout(10_000) })).arrayBuffer())
          inputParts.push({
            kind: 'file', class: 'FileWithUri', name: part.filename, mimeType: part.mediaType,
            bytes: bytes.byteLength, sha256: digest(bytes),
          })
        } else {
          throw new Error(`unexpected Python input Part ${content.$case}`)
        }
      }
      parts = [
        { content: { $case: 'data', value: { inputParts } }, metadata: undefined, filename: '', mediaType: 'application/json' },
        { content: { $case: 'raw', value: javascriptOutputInline }, metadata: undefined, filename: 'javascript-output-inline.bin', mediaType: 'application/x-javascript-output-inline' },
        { content: { $case: 'url', value: `${this.baseUrl}/published/javascript-output-uri.bin` }, metadata: undefined, filename: 'javascript-output-uri.bin', mediaType: 'application/x-javascript-output-uri' },
      ]
    } else if (content.$case === 'data') {
      assert.deepEqual(content.value, {
        schema: 'urn:deepseek-harness:a2a:input-response:v1', answers: [{ id: 'environment', selected: ['Test'] }],
      })
      parts = [{ content: { $case: 'text', value: `selected:${content.value.answers[0].selected[0]}` }, metadata: undefined, filename: '', mediaType: 'text/plain' }]
    } else {
      parts = [{ content: { $case: 'text', value: `reply:${text}` }, metadata: undefined, filename: '', mediaType: 'text/plain' }]
    }
    const artifact = {
      artifactId: 'python-client-result',
      name: 'result',
      description: '',
      parts,
      metadata: undefined,
      extensions: [],
    }
    events.publish(AgentEvent.artifactUpdate({
      taskId: task.id,
      contextId: task.contextId,
      artifact,
      append: false,
      lastChunk: true,
      metadata: undefined,
    }))
    events.publish(AgentEvent.statusUpdate(status(task, TaskState.TASK_STATE_COMPLETED)))
    this.runs.delete(task.id)
  }

  async cancelTask(taskId, events) {
    const run = this.runs.get(taskId)
    assert.ok(run)
    run.canceled = true
    events.publish(AgentEvent.statusUpdate(status(run.task, TaskState.TASK_STATE_CANCELED)))
    run.release.resolve()
    this.runs.delete(taskId)
  }
}

function rawConfig(baseUrl) {
  return {
    route: '/a2a',
    publicBaseUrl: baseUrl,
    agent: {
      name: 'Python 0.3.2 client target',
      description: 'Exact-version interoperability fixture',
      version: '1.0.0',
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [{ id: 'interop', name: 'Interop', description: 'Interop', tags: ['test'] }],
    },
  }
}

async function openJavaScriptBridge() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const config = resolveConfig(rawConfig(baseUrl), { host: '127.0.0.1', port: address.port, env: {} })
  const handler = new DefaultRequestHandler(config.agentCard, new InMemoryTaskStore(), new PythonClientExecutor(baseUrl))
  const application = createA2AHttpApplication(config, handler)
  server.on('request', (request, response) => {
    if (request.url === '/fixture-input/large') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(pythonInputUri.byteLength),
      })
      response.end(pythonInputUri)
      return
    }
    if (request.url === '/published/javascript-output-uri.bin') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(javascriptOutputUri.byteLength),
      })
      response.end(javascriptOutputUri)
      return
    }
    application.dispatch(request, response)
  })
  return {
    baseUrl,
    async close() {
      const stopped = new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
      const drained = application.close()
      void drained.then(() => server.closeIdleConnections(), () => server.closeIdleConnections())
      await Promise.all([stopped, drained])
    },
  }
}

async function startPythonServer(tempDirectory) {
  const child = spawn(python, [peer, 'server', tempDirectory], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  const output = []
  const errors = []
  child.stdout.on('data', chunk => output.push(chunk))
  child.stderr.on('data', chunk => errors.push(chunk))
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const diagnostics = () => `stdout:\n${Buffer.concat(output).toString('utf8')}\nstderr:\n${Buffer.concat(errors).toString('utf8')}`
  async function close() {
    child.stdin.end()
    try {
      const result = await bounded(exited, 'Python server shutdown')
      assert.equal(result.signal, null, diagnostics())
      assert.equal(result.code, 0, diagnostics())
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await bounded(exited, 'Python server termination')
      throw new Error(`${error.message}\n${diagnostics()}`, { cause: error })
    } finally {
      lines.close()
      child.stdin.destroy()
    }
  }
  try {
    const readiness = await bounded(Promise.race([
      once(lines, 'line').then(([line]) => JSON.parse(line)),
      exited.then(result => { throw new Error(`Python server exited before readiness: ${JSON.stringify(result)}`) }),
    ]), 'Python server readiness')
    assert.equal(readiness.packageVersion, '0.3.2')
    return { baseUrl: readiness.baseUrl, close, diagnostics }
  } catch (error) {
    try { await close() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], diagnostics())
    }
    throw new Error(`${error.message}\n${diagnostics()}`, { cause: error })
  }
}

async function openFileTransfer(root) {
  const objects = join(root, 'objects')
  await mkdir(objects, { recursive: true })
  const stored = new Map()
  const paths = new Map()
  const hosted = new Map()
  let sequence = 0
  const fileServer = createServer((request, response) => {
    const bytes = hosted.get(request.url)
    if (bytes === undefined) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
    })
    response.end(bytes)
  })
  fileServer.listen(0, '127.0.0.1')
  await once(fileServer, 'listening')
  const address = fileServer.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const attachments = {
    async saveFileStream(input) {
      const chunks = []
      for await (const chunk of input.data) chunks.push(Buffer.from(chunk))
      const data = Buffer.concat(chunks)
      const name = input.name ?? 'file'
      const attachmentId = `sha256:python-interop-${sequence++}`
      const path = join(objects, `${sequence}-${name}`)
      await writeFile(path, data)
      stored.set(attachmentId, data)
      paths.set(attachmentId, path)
      return { attachmentId, name, bytes: data.byteLength }
    },
    async *readFileStream(ref) { yield stored.get(ref.attachmentId) },
    fileHostPath(ref) { return paths.get(ref.attachmentId) },
  }
  const transfer = new A2AFileTransfer({
    attachments,
    fileUploads: { uploadStream: async () => { throw new Error('unexpected upload') } },
    maxFileBytes: 2 * MIB,
    inlineFileMaxBytes: MIB,
    fetchTimeoutMs: 10_000,
    maxRedirects: 2,
    publishFileAllowedRoots: [],
    fileLinks: {
      async issue(file) {
        const path = `/files/${hosted.size}`
        hosted.set(path, stored.get(file.ref.attachmentId))
        return new URL(path, baseUrl)
      },
    },
  })
  return {
    transfer,
    async close() {
      await bounded(new Promise((resolve, reject) => {
        fileServer.close(error => error ? reject(error) : resolve())
        fileServer.closeAllConnections()
      }), 'File server shutdown')
    },
  }
}

test('interoperates in both directions with Python a2a-sdk 0.3.2', {
  skip: python === undefined ? 'set DSH_A2A_PYTHON032 to an interpreter with a2a-sdk==0.3.2' : false,
  timeout: 60_000,
}, async (context) => {
  const tempBase = process.env.DSH_A2A_INTEROP_TMP ?? tmpdir()
  await mkdir(tempBase, { recursive: true })
  const root = await mkdtemp(join(tempBase, 'dsh-a2a-python032-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const bridge = await openJavaScriptBridge()
  let clientOutput = ''
  try {
    const pythonClientTemp = join(root, 'python-client')
    const { stdout, stderr } = await execFileAsync(python, [peer, 'client', bridge.baseUrl, pythonClientTemp], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    clientOutput = `stdout:\n${stdout}\nstderr:\n${stderr}`
    const verdict = JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
    assert.equal(verdict.packageVersion, '0.3.2')
    assert.equal(verdict.output, '')
    assert.deepEqual(verdict.input.inputParts, [
      { kind: 'text', text: 'python-files' },
      { kind: 'data', data: { source: 'python', order: 2 } },
      {
        kind: 'file', class: 'FileWithBytes', name: 'python-inline.bin',
        mimeType: 'application/x-python-inline', bytes: MIB, sha256: digest(pythonInputInline),
      },
      {
        kind: 'file', class: 'FileWithUri', name: 'python-uri.bin',
        mimeType: 'application/x-python-uri', bytes: MIB + 1, sha256: digest(pythonInputUri),
      },
    ])
    assert.deepEqual(verdict.outputFiles, [
      {
        class: 'FileWithBytes', name: 'javascript-output-inline.bin',
        mimeType: 'application/x-javascript-output-inline', artifactId: 'python-client-result',
        bytes: MIB, sha256: digest(javascriptOutputInline),
      },
      {
        class: 'FileWithUri', name: 'javascript-output-uri.bin',
        mimeType: 'application/x-javascript-output-uri', artifactId: 'python-client-result',
        bytes: MIB + 1, sha256: digest(javascriptOutputUri),
      },
    ])
    assert.equal(verdict.lookupState, 'completed')
    assert.equal(verdict.canceledState, 'canceled')
    assert.deepEqual(verdict.interaction, {
      state: 'input-required', lookupState: 'input-required',
      text: 'Select the environment',
      data: { schema: 'urn:deepseek-harness:a2a:input-required:v1', questions: [
        { id: 'environment', question: 'Select the environment', options: [{ label: 'Test' }, { label: 'Production' }] },
      ] },
      sameTask: true, sameContext: true, completedState: 'completed', output: 'selected:Test',
    })
  } catch (error) {
    assert.notEqual(error.killed, true, `Python client was terminated or timed out\n${error.stdout ?? ''}\n${error.stderr ?? ''}`)
    assert.equal(error.signal ?? null, null, `Python client received ${error.signal}`)
    throw new Error(`${error.message}\n${clientOutput || `stdout:\n${error.stdout ?? ''}\nstderr:\n${error.stderr ?? ''}`}`, { cause: error })
  } finally {
    await bridge.close()
  }

  await writeFile(join(root, 'javascript-inline.bin'), javascriptInputInline)
  await writeFile(join(root, 'javascript-uri.bin'), javascriptInputUri)
  const fileTransfer = await openFileTransfer(root)
  let remote
  try {
    remote = await startPythonServer(join(root, 'python-server'))
    const caller = new A2AAgentClient({
      maxTimeoutMs: 10_000,
      maxResponseBytes: 3 * MIB,
      maxRedirects: 2,
      cancelTimeoutMs: 2_000,
      fileTransfer: fileTransfer.transfer,
    })
    const result = await caller.call({
      agent_card_url: `${remote.baseUrl}/.well-known/agent-card.json`,
      message: 'javascript-files',
      files: [
        { path: 'javascript-inline.bin', name: 'javascript-inline.bin', mime_type: 'application/x-javascript-inline' },
        { path: 'javascript-uri.bin', name: 'javascript-uri.bin', mime_type: 'application/x-javascript-uri' },
      ],
      stream: true,
    }, new AbortController().signal, root)
    assert.equal(result.state, 'TASK_STATE_COMPLETED')
    assert.deepEqual(result.output.inputParts, [
      { kind: 'text', text: 'javascript-files' },
      {
        kind: 'file', class: 'FileWithBytes', name: 'javascript-inline.bin',
        mimeType: 'application/x-javascript-inline', bytes: MIB, sha256: digest(javascriptInputInline),
      },
      {
        kind: 'file', class: 'FileWithUri', name: 'javascript-uri.bin',
        mimeType: 'application/x-javascript-uri', bytes: MIB + 1, sha256: digest(javascriptInputUri),
      },
    ])
    assert.deepEqual(result.files.map(file => ({ ...file, path: undefined })), [
      {
        path: undefined, name: 'python-output-inline.bin', mime_type: 'application/x-python-output-inline',
        bytes: MIB, artifact_id: 'python-files',
      },
      {
        path: undefined, name: 'python-output-uri.bin', mime_type: 'application/x-python-output-uri',
        bytes: MIB + 1, artifact_id: 'python-files',
      },
    ])
    assert.equal(digest(await readFile(result.files[0].path)), digest(pythonOutputInline))
    assert.equal(digest(await readFile(result.files[1].path)), digest(pythonOutputUri))
    const question = await caller.call({
      agent_card_url: `${remote.baseUrl}/.well-known/agent-card.json`,
      message: 'javascript-question', stream: true,
    }, new AbortController().signal, root)
    assert.equal(question.state, 'TASK_STATE_INPUT_REQUIRED')
    assert.deepEqual(question.interaction, {
      text: 'Select the environment',
      data: [{ schema: 'urn:deepseek-harness:a2a:input-required:v1', questions: [
        { id: 'environment', question: 'Select the environment', options: [{ label: 'Test' }, { label: 'Production' }] },
      ] }],
    })
    assert.equal(question.files.length, 1)
    assert.deepEqual({ ...question.files[0], path: undefined }, {
      path: undefined, name: 'question-guide.txt', mime_type: 'text/plain', bytes: 14, artifact_id: '',
    })
    assert.equal(await readFile(question.files[0].path, 'utf8'), 'Choose safely.')
    const completed = await caller.call({
      agent_card_url: `${remote.baseUrl}/.well-known/agent-card.json`,
      task_id: question.task_id, context_id: question.context_id,
      message: { schema: 'urn:deepseek-harness:a2a:input-response:v1', answers: [{ id: 'environment', selected: ['Test'] }] },
      stream: true,
    }, new AbortController().signal, root)
    assert.equal(completed.task_id, question.task_id)
    assert.equal(completed.context_id, question.context_id)
    assert.equal(completed.state, 'TASK_STATE_COMPLETED')
    assert.equal(completed.output, 'selected:Test')
    assert.equal(completed.interaction, undefined)
  } catch (error) {
    throw new Error(`${error.message}\n${remote?.diagnostics() ?? ''}`, { cause: error })
  } finally {
    await Promise.all([remote?.close(), fileTransfer.close()])
  }
})
