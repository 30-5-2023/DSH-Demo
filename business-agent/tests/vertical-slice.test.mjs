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
      maxConsecutiveWakes: 4,
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
    const waiting = await waitFor(
      () => snapshot(url),
      value => value.order.activities[1].status === 'waiting',
      'first interaction snapshot',
    )
    assert.deepEqual(waiting.order.activities.map(activity => activity.status), [
      'done', 'waiting', 'pending', 'pending', 'pending',
    ])
    const rounds = [
      ['activity-credit-analysis', { creditTerm: 24, guaranteeType: 'mortgage', analysisNote: '关注现金流' }],
      ['activity-manual-review', { reviewer: '王敏', reviewDate: '2026-09-22', supportingFile: { resourceId: 'resource-upload-001' } }],
      ['activity-compliance-check', { matchedRules: ['ratio'], conditionalPass: true, qualityComment: '补齐材料后通过' }],
      ['activity-archive-review', { archiveName: '授信复核-2026', conflictPolicy: 'rename', confirmed: true }],
    ]
    for (let index = 0; index < rounds.length; index += 1) {
      const [activityId, values] = rounds[index]
      await waitFor(() => inbox.length, count => count === index + 1, `interaction wake ${String(index + 1)}`)
      const wakeText = inbox[index].content[0].text
      assert.match(wakeText, /get_interaction_request/)
      const interactionId = service.state.orders.get(SEED_ORDER_ID).activities[index + 1].interactionId
      const read = await execute(ctx.tools, agent, 'get_interaction_request', {
        orderId: SEED_ORDER_ID,
        interactionId,
      }, `vertical-interaction-read-${String(index + 1)}`)
      assert.equal(read.isError, false)
      const request = read.value.structuredContent
      const submitted = await execute(ctx.tools, agent, 'submit_interaction_response', {
        orderId: SEED_ORDER_ID,
        interactionId,
        expectedOrderRevision: request.orderRevision,
        idempotencyKey: `vertical-submit-${String(index + 1)}`,
        values,
      }, `vertical-interaction-submit-${String(index + 1)}`)
      assert.equal(submitted.isError, false)
      executor.complete(activityId)
      if (index < rounds.length - 1) {
        await waitFor(
          () => snapshot(url),
          value => value.order.activities[index + 2].status === 'waiting',
          `interaction ${String(index + 2)} waiting`,
        )
      }
    }
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
    assert.equal(inbox.length, 4, 'only interaction-required events enter Agent context')
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await service.close()
    assert.equal(service.state.subscribers.size, 0)
    assert.equal(service.state.eventStreams.size, 0)
  }
})
