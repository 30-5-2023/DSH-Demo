import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { Role, TaskState } from '@a2a-js/sdk'
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
  createCallA2AAgentTool,
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

async function openRemote() {
  const executor = new RemoteExecutor()
  const store = new InMemoryTaskStore()
  let cardFetches = 0
  const app = express()
  const server = createServer(app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  const card = {
    name: 'Remote Agent', description: 'Remote fixture', version: '1.0.0', provider: undefined,
    supportedInterfaces: [{ url: `${base}/a2a`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {}, securityRequirements: [],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [{ id: 'remote', name: 'Remote', description: 'Remote', tags: ['remote'], examples: [], inputModes: ['text/plain'], outputModes: ['text/plain'], securityRequirements: [] }],
    signatures: [],
  }
  const handler = new DefaultRequestHandler(card, store, executor)
  app.use('/.well-known/agent-card.json', (req, _res, next) => { cardFetches += 1; next() }, agentCardHandler({ agentCardProvider: handler }))
  app.use('/a2a', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }))
  return {
    executor,
    cardUrl: `${base}/.well-known/agent-card.json`,
    get cardFetches() { return cardFetches },
    async close() {
      server.close()
      await once(server, 'close')
    },
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

test('defines exactly the URL-only tool schema and safe presentations', () => {
  const caller = { call: async () => ({ context_id: 'ctx', task_id: 'task', state: 'TASK_STATE_COMPLETED', output: 'done' }) }
  const tool = createCallA2AAgentTool(caller, 5_000)
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
    'accepted_output_mode', 'agent_card_url', 'context_id', 'message', 'stream', 'timeout_ms',
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
