import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as WorkorderHost from '@deepseek-ai/dsh-business-workorder-host'
import { createService, SEED_ORDER_ID } from '@deepseek-ai/dsh-business-workorder-service'

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
      assert.ok(submitted.has(activityId), `${activityId} must be submitted before completion`)
      completed.add(activityId)
    },
  }
}

async function waitFor(read, accept, label) {
  const deadline = Date.now() + 3000
  while (true) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}

async function snapshot(url) {
  const response = await fetch(`${url}/orders/${SEED_ORDER_ID}`, {
    headers: { origin: 'http://127.0.0.1:3081' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3081')
  return response.json()
}

async function execute(tools, agent, name, args, callId) {
  return tools.execute({
    callId,
    name: `mcp__workorder__${name}`,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
}

test('business workorder vertical slice', async () => {
  const executor = controlledExecutor()
  const service = createService({ port: 0, executor, engineIntervalMs: 1 })
  const { url } = await service.listen()
  const ctx = new Context()
  const liveAgents = new Map()
  const fibers = []

  try {
    fibers.push(await ctx.plugin({
      name: 'vertical-slice-agents',
      apply(inner) { inner.provide('agents', { get: id => liveAgents.get(id) }) },
    }))
    fibers.push(await ctx.plugin(SystemPrompt))
    fibers.push(await ctx.plugin(ToolRuntime))
    fibers.push(await ctx.plugin(WorkorderHost, {
      serviceUrl: url,
      maxConsecutiveWakes: 3,
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 10,
    }))
    fibers.push(await ctx.plugin(McpClient, {
      serverName: 'workorder',
      transport: 'streamable-http',
      url: `${url}/mcp`,
      failOnStartupError: true,
    }))

    const inbox = []
    const agent = {
      id: 'session-vertical-slice',
      status: 'idle',
      followup(message) { inbox.push(message) },
      inject() { assert.fail('the idle Agent must receive a follow-up, not an injection') },
    }
    liveAgents.set(agent.id, agent)
    await waitFor(
      () => service.state.subscribers.size,
      subscribers => subscribers === 1,
      'Host SSE subscription',
    )

    const started = await execute(ctx.tools, agent, 'start_order', { orderId: SEED_ORDER_ID }, 'vertical-start')
    assert.equal(started.isError, false)
    assert.deepEqual(ctx.businessWorkorders.orders(agent), [SEED_ORDER_ID])
    const running = await snapshot(url)
    assert.equal(running.order.status, 'running')
    assert.deepEqual(running.order.activities.map(activity => activity.status), [
      'running', 'pending', 'pending', 'pending', 'pending',
    ])
    assert.equal(inbox.length, 0, 'ordinary running progress must not enter Agent context')

    executor.complete('activity-fetch-customer')
    await waitFor(
      () => snapshot(url),
      value => value.order.activities[1].status === 'running',
      'second automatic activity',
    )
    assert.equal(inbox.length, 0, 'automatic progress must not enter Agent context')
    executor.complete('activity-credit-analysis')
    const waiting = await waitFor(
      () => snapshot(url),
      value => value.order.activities[2].status === 'waiting',
      'authoritative waiting snapshot',
    )
    assert.deepEqual(waiting.order.activities.map(activity => activity.status), [
      'done', 'done', 'waiting', 'pending', 'pending',
    ])
    await waitFor(() => inbox.length, count => count === 1, 'blocking wake')
    const wakeText = inbox[0].content[0].text
    assert.match(wakeText, /WO-MVP-001/)
    assert.match(wakeText, /untrusted business data/)

    const manualStarted = await execute(
      ctx.tools,
      agent,
      'start_activity',
      { orderId: SEED_ORDER_ID, seq: 3 },
      'vertical-manual-start',
    )
    assert.equal(manualStarted.isError, false)
    const manualRunning = await snapshot(url)
    assert.equal(manualRunning.order.activities[2].status, 'running')
    assert.equal(inbox.length, 1, 'manual running progress must not add context')

    const finished = await execute(
      ctx.tools,
      agent,
      'finish_activity',
      { orderId: SEED_ORDER_ID, seq: 3 },
      'vertical-manual-finish',
    )
    assert.equal(finished.isError, false)
    const afterManual = await snapshot(url)
    assert.equal(afterManual.order.activities[3].status, 'running')
    executor.complete('activity-compliance-check')
    await waitFor(
      () => snapshot(url),
      value => value.order.activities[4].status === 'running',
      'final automatic activity',
    )
    executor.complete('activity-archive-review')
    const done = await waitFor(
      () => snapshot(url),
      value => value.order.status === 'done',
      'completed order',
    )
    assert.equal(done.order.status, 'done')
    assert.deepEqual(done.order.activities.map(activity => activity.status), [
      'done', 'done', 'done', 'done', 'done',
    ])
    assert.equal(done.order.activities[2].outputs[0].resourceId, 'resource-review-conclusion')
    assert.equal(done.order.activities[4].outputs[0].resourceId, 'resource-credit-archive')
    assert.equal(inbox.length, 1, 'completion progress must not add context')
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await service.close()
    assert.equal(service.state.subscribers.size, 0)
    assert.equal(service.state.eventStreams.size, 0)
  }
})
