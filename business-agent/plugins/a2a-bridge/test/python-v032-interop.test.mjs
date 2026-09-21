import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Role, TaskState } from '@a2a-js/sdk'
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server'
import {
  A2AAgentClient,
  createA2AHttpApplication,
  resolveConfig,
} from '../lib/index.js'

const execFileAsync = promisify(execFile)
const python = process.env.DSH_A2A_PYTHON032
const peer = fileURLToPath(new URL('../../../tests/fixtures/a2a-python-v032-peer.py', import.meta.url))

function deferred() { return Promise.withResolvers() }

function status(task, state) {
  return {
    taskId: task.id,
    contextId: task.contextId,
    status: { state, message: undefined, timestamp: new Date().toISOString() },
    metadata: undefined,
  }
}

class PythonClientExecutor {
  constructor() {
    this.runs = new Map()
  }

  async execute(request, events) {
    const text = request.userMessage.parts[0].content.value
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
    if (text === 'python-cancel') await release.promise
    if (run.canceled) return
    const artifact = {
      artifactId: 'python-client-result',
      name: 'result',
      description: '',
      parts: [{ content: { $case: 'text', value: `reply:${text}` }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
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
  const handler = new DefaultRequestHandler(config.agentCard, new InMemoryTaskStore(), new PythonClientExecutor())
  const application = createA2AHttpApplication(config, handler)
  server.on('request', application.dispatch)
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

async function startPythonServer() {
  const child = spawn(python, [peer, 'server'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  const errors = []
  child.stderr.on('data', chunk => errors.push(chunk))
  const readiness = await Promise.race([
    once(lines, 'line').then(([line]) => JSON.parse(line)),
    once(child, 'exit').then(([code, signal]) => {
      throw new Error(`Python A2A server exited before readiness (${code ?? signal}): ${Buffer.concat(errors).toString('utf8')}`)
    }),
  ])
  return {
    child,
    baseUrl: readiness.baseUrl,
    async close() {
      if (child.exitCode !== null) return
      child.kill()
      await once(child, 'exit')
    },
  }
}

test('interoperates in both directions with Python a2a-sdk 0.3.2', {
  skip: python === undefined ? 'set DSH_A2A_PYTHON032 to an interpreter with a2a-sdk==0.3.2' : false,
  timeout: 60_000,
}, async () => {
  const bridge = await openJavaScriptBridge()
  try {
    const { stdout } = await execFileAsync(python, [peer, 'client', bridge.baseUrl], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    const verdict = JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
    assert.equal(verdict.packageVersion, '0.3.2')
    assert.equal(verdict.output, 'reply:python-to-js')
    assert.equal(verdict.lookupState, 'completed')
    assert.equal(verdict.canceledState, 'canceled')
  } finally {
    await bridge.close()
  }

  const remote = await startPythonServer()
  try {
    const caller = new A2AAgentClient({
      maxTimeoutMs: 10_000,
      maxResponseBytes: 65_536,
      maxRedirects: 2,
      cancelTimeoutMs: 2_000,
    })
    const result = await caller.call({
      agent_card_url: `${remote.baseUrl}/.well-known/agent-card.json`,
      message: 'js-to-python',
      stream: true,
    }, new AbortController().signal)
    assert.equal(result.state, 'TASK_STATE_COMPLETED')
    assert.equal(result.output, 'py032:js-to-python')
  } finally {
    await remote.close()
  }
})
