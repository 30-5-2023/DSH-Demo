import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createService, SEED_ORDER_ID, tick } from '@deepseek-ai/dsh-business-workorder-service'
import * as WorkorderHost from '../lib/index.js'

function controlledExecutor() {
  const submitted = new Set()
  const completed = new Set()
  return {
    kind: 'controlled',
    submit(activity) { submitted.add(activity.id) },
    poll(activity) {
      if (!completed.has(activity.id)) return false
      completed.delete(activity.id)
      return true
    },
    complete(activityId) {
      assert.ok(submitted.has(activityId))
      completed.add(activityId)
    },
  }
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}

const executor = controlledExecutor()
const service = createService({ port: 0, executor, engineIntervalMs: 60_000 })
const { url } = await service.listen()
const ctx = new Context()
const liveAgents = new Map()
const agentsFiber = await ctx.plugin({
  name: 'business-test-agents',
  apply(inner) {
    inner.provide('agents', { get: id => liveAgents.get(id) })
  },
})
const systemPromptFiber = await ctx.plugin(SystemPrompt)
const toolsFiber = await ctx.plugin(ToolRuntime)
const hostFiber = await ctx.plugin(WorkorderHost, {
  serviceUrl: url,
  maxConsecutiveWakes: 3,
  reconnectInitialDelayMs: 10,
  reconnectMaxDelayMs: 20,
})
const mcpFiber = await ctx.plugin(McpClient, {
  serverName: 'workorder',
  transport: 'streamable-http',
  url: `${url}/mcp`,
  failOnStartupError: true,
})

try {
  const tools = ctx.tools
  const bindings = ctx.businessWorkorders
  assert.ok(tools)
  assert.ok(bindings)
  const names = ['get_order', 'start_order', 'start_activity', 'finish_activity', 'get_interaction_request', 'submit_interaction_response']
    .map(toolName => `mcp__workorder__${toolName}`)
  for (const toolName of names) assert.ok(tools.get(toolName), `missing native tool ${toolName}`)
  assert.equal(tools.get('start_order'), undefined)

  const wake = Promise.withResolvers()
  const primaryAgent = {
    id: 'session-primary',
    status: 'idle',
    followup(message) { wake.resolve(message) },
    inject() { assert.fail('idle Agent must not receive an injected wake') },
  }
  liveAgents.set(primaryAgent.id, primaryAgent)
  await waitFor(() => service.state.subscribers.size === 1, 'Host SSE subscription')
  const success = await tools.execute({
    callId: 'business-call-1',
    name: 'mcp__workorder__start_order',
    arguments: { orderId: SEED_ORDER_ID },
    agent: primaryAgent,
    signal: new AbortController().signal,
  })
  assert.equal(success.isError, false)
  assert.deepEqual(bindings.orders(primaryAgent), [SEED_ORDER_ID])
  executor.complete('activity-fetch-customer')
  assert.equal(tick(service.state, executor), 1)
  const wakeMessage = await wake.promise
  assert.match(wakeMessage.content[0].text, /WO-MVP-001/)
  assert.match(wakeMessage.content[0].text, /get_interaction_request/)
  assert.match(wakeMessage.content[0].text, /untrusted business data/)

  const failedAgent = { id: 'session-failed', status: 'idle', followup() {}, inject() {} }
  const failed = await tools.execute({
    callId: 'business-call-2',
    name: 'mcp__workorder__get_order',
    arguments: { orderId: 'missing-order' },
    agent: failedAgent,
    signal: new AbortController().signal,
  })
  assert.equal(failed.isError, true)
  assert.deepEqual(bindings.orders(failedAgent), [])

  const nestedAgent = { id: 'session-nested', status: 'idle', followup() {}, inject() {} }
  const nested = await tools.execute({
    callId: 'business-call-3',
    rootCallId: 'business-root-3',
    parent: Symbol('parent'),
    name: 'mcp__workorder__get_order',
    arguments: { orderId: SEED_ORDER_ID },
    agent: nestedAgent,
    signal: new AbortController().signal,
  })
  assert.equal(nested.isError, false)
  assert.deepEqual(bindings.orders(nestedAgent), [])

  const withoutAgent = await tools.execute({
    callId: 'business-call-4',
    name: 'mcp__workorder__get_order',
    arguments: { orderId: SEED_ORDER_ID },
    signal: new AbortController().signal,
  })
  assert.equal(withoutAgent.isError, false)
  assert.deepEqual(bindings.orders(primaryAgent), [SEED_ORDER_ID])
  process.stdout.write('business-workorder-host: native MCP tools and binding rules passed\n')
} finally {
  await mcpFiber.dispose()
  await hostFiber.dispose()
  await toolsFiber.dispose()
  await systemPromptFiber.dispose()
  await agentsFiber.dispose()
  await service.close()
}
