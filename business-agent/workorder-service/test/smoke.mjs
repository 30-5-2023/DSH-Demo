import assert from 'node:assert/strict'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createService, MCP_PATH, SEED_ORDER_ID } from '../src/index.js'

function createControlledExecutor() {
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
      assert.ok(submitted.has(activityId), `activity ${activityId} must be submitted before completion`)
      completed.add(activityId)
    },
  }
}

async function openEventStream(url) {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } })
  assert.equal(response.status, 200)
  const events = []
  const waiters = new Set()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deliver = (event) => {
    events.push(event)
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue
      waiters.delete(waiter)
      clearTimeout(waiter.timeout)
      waiter.resolve(event)
    }
  }
  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = block.split('\n').find(line => line.startsWith('data: '))
          if (data !== undefined) deliver(JSON.parse(data.slice(6)))
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch (error) {
      if (error?.name !== 'AbortError') throw error
    }
  })()
  const next = (predicate, timeoutMs = 3000) => {
    const existing = events.find(predicate)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error(`SSE event timed out; received ${JSON.stringify(events)}`))
        }, timeoutMs),
      }
      waiters.add(waiter)
    })
  }
  return {
    events,
    next,
    async close() {
      controller.abort()
      await pump
    },
  }
}

function parseToolResult(response) {
  const block = response.content.find(item => item.type === 'text')
  assert.ok(block, 'tool response must contain a text block')
  return JSON.parse(block.text)
}

const executor = createControlledExecutor()
const service = createService({
  port: 0,
  debug: true,
  executor,
  engineIntervalMs: 5,
  corsOrigins: ['*'],
  now: () => '2026-09-18T00:00:00.000Z',
})
const { url } = await service.listen()
const client = new Client({ name: 'business-workorder-smoke', version: '0.1.0' }, { capabilities: {} })
const stream = await openEventStream(`${url}/events?orderId=${SEED_ORDER_ID}`)

try {
  await stream.next(event => event.type === 'ready')
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}${MCP_PATH}`)))

  const healthResponse = await fetch(`${url}/health`, { headers: { origin: 'http://127.0.0.1:3081' } })
  assert.equal(healthResponse.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await healthResponse.json(), {
    ok: true,
    service: '@deepseek-ai/dsh-business-workorder-service',
    rev: 0,
    orders: 1,
  })

  const initial = await (await fetch(`${url}/orders/${SEED_ORDER_ID}`)).json()
  assert.equal(initial.order.status, 'ready')
  assert.equal(initial.order.createdAt, '2026-09-18T00:00:00.000Z')
  assert.deepEqual(initial.order.activities.map(activity => activity.status), [
    'pending', 'pending', 'pending', 'pending', 'pending',
  ])
  assert.equal((await fetch(`${url}/bindings/session-1`)).status, 404)

  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
    'finish_activity', 'get_interaction_request', 'get_order', 'start_activity', 'start_order', 'submit_interaction_response',
  ])
  assert.equal(client.getServerVersion()?.instructions, undefined)

  const started = parseToolResult(await client.callTool({
    name: 'start_order',
    arguments: { orderId: SEED_ORDER_ID },
  }))
  assert.equal(started.accepted, true)
  assert.equal(started.activityStatus, 'running', 'start_order must return before background completion')
  assert.deepEqual(service.state.orders.get(SEED_ORDER_ID).activities.map(activity => activity.status), [
    'running', 'pending', 'pending', 'pending', 'pending',
  ])

  const duplicate = await client.callTool({ name: 'start_order', arguments: { orderId: SEED_ORDER_ID } })
  assert.equal(duplicate.isError, true, 'starting a non-ready order must be rejected')

  const analysisInteractionEvent = stream.next(event => event.type === 'interaction.required' && event.activityId === 'activity-credit-analysis')
  executor.complete('activity-fetch-customer')
  const analysisRequired = await analysisInteractionEvent
  assert.equal(analysisRequired.needsHuman, true)
  assert.ok(!('sessionId' in analysisRequired))
  assert.ok(!('message' in analysisRequired))

  const afterAutomatic = parseToolResult(await client.callTool({
    name: 'get_order',
    arguments: { orderId: SEED_ORDER_ID },
  }))
  assert.deepEqual(afterAutomatic.order.activities.map(activity => activity.status), [
    'done', 'waiting', 'pending', 'pending', 'pending',
  ])
  assert.equal(afterAutomatic.order.activities[0].outputs[0].resourceId, 'resource-customer-master')
  const analysisRequest = parseToolResult(await client.callTool({
    name: 'get_interaction_request',
    arguments: { orderId: SEED_ORDER_ID, interactionId: analysisRequired.interactionId },
  }))
  assert.equal(analysisRequest.type, 'interaction-request')
  assert.deepEqual(analysisRequest.fields.map(field => field.type), ['integer', 'select', 'textarea'])
  const invalidAnalysis = await client.callTool({
    name: 'submit_interaction_response',
    arguments: {
      orderId: SEED_ORDER_ID,
      interactionId: analysisRequired.interactionId,
      expectedOrderRevision: analysisRequest.orderRevision,
      idempotencyKey: 'analysis-invalid-1',
      values: { creditTerm: 121, guaranteeType: 'invented', analysisNote: '' },
    },
  })
  assert.equal(invalidAnalysis.isError, true, 'server validation must reject invalid field values')
  const analysisSubmitted = parseToolResult(await client.callTool({
    name: 'submit_interaction_response',
    arguments: {
      orderId: SEED_ORDER_ID,
      interactionId: analysisRequired.interactionId,
      expectedOrderRevision: analysisRequest.orderRevision,
      idempotencyKey: 'analysis-submit-1',
      values: { creditTerm: 24, guaranteeType: 'mortgage', analysisNote: '关注现金流变化' },
    },
  }))
  assert.equal(analysisSubmitted.activityStatus, 'running')
  assert.deepEqual(parseToolResult(await client.callTool({
    name: 'submit_interaction_response',
    arguments: {
      orderId: SEED_ORDER_ID,
      interactionId: analysisRequired.interactionId,
      expectedOrderRevision: analysisRequest.orderRevision,
      idempotencyKey: 'analysis-submit-1',
      values: { creditTerm: 24, guaranteeType: 'mortgage', analysisNote: '关注现金流变化' },
    },
  })), analysisSubmitted, 'an idempotency key must replay its first result')
  const idempotencyConflict = await client.callTool({
    name: 'submit_interaction_response',
    arguments: {
      orderId: SEED_ORDER_ID,
      interactionId: analysisRequired.interactionId,
      expectedOrderRevision: analysisRequest.orderRevision,
      idempotencyKey: 'analysis-submit-1',
      values: { creditTerm: 36, guaranteeType: 'none', analysisNote: 'different values' },
    },
  })
  assert.equal(idempotencyConflict.isError, true, 'an idempotency key must reject different values')

  const manualInteractionEvent = stream.next(event => event.type === 'interaction.required' && event.activityId === 'activity-manual-review')
  executor.complete('activity-credit-analysis')
  const manualRequired = await manualInteractionEvent
  const manualRequest = parseToolResult(await client.callTool({
    name: 'get_interaction_request', arguments: { orderId: SEED_ORDER_ID, interactionId: manualRequired.interactionId },
  }))
  assert.deepEqual(manualRequest.fields.map(field => field.type), ['text', 'date', 'resource'])
  parseToolResult(await client.callTool({
    name: 'submit_interaction_response',
    arguments: {
      orderId: SEED_ORDER_ID, interactionId: manualRequired.interactionId,
      expectedOrderRevision: manualRequest.orderRevision, idempotencyKey: 'manual-submit-1',
      values: { reviewer: '王敏', reviewDate: '2026-09-22', supportingFile: { resourceId: 'resource-upload-001' } },
    },
  }))

  const qualityInteractionEvent = stream.next(event => event.type === 'interaction.required' && event.activityId === 'activity-compliance-check')
  executor.complete('activity-manual-review')
  const qualityRequired = await qualityInteractionEvent
  const qualityRequest = parseToolResult(await client.callTool({
    name: 'get_interaction_request', arguments: { orderId: SEED_ORDER_ID, interactionId: qualityRequired.interactionId },
  }))
  assert.deepEqual(qualityRequest.fields.map(field => field.type), ['multi-select', 'boolean', 'textarea'])
  parseToolResult(await client.callTool({
    name: 'submit_interaction_response',
    arguments: {
      orderId: SEED_ORDER_ID, interactionId: qualityRequired.interactionId,
      expectedOrderRevision: qualityRequest.orderRevision, idempotencyKey: 'quality-submit-1',
      values: { matchedRules: ['ratio', 'document'], conditionalPass: true, qualityComment: '补齐材料后通过' },
    },
  }))

  const archiveInteractionEvent = stream.next(event => event.type === 'interaction.required' && event.activityId === 'activity-archive-review')
  executor.complete('activity-compliance-check')
  const archiveRequired = await archiveInteractionEvent
  const archiveRequest = parseToolResult(await client.callTool({
    name: 'get_interaction_request', arguments: { orderId: SEED_ORDER_ID, interactionId: archiveRequired.interactionId },
  }))
  assert.deepEqual(archiveRequest.fields.map(field => field.type), ['text', 'select', 'boolean'])
  parseToolResult(await client.callTool({
    name: 'submit_interaction_response',
    arguments: {
      orderId: SEED_ORDER_ID, interactionId: archiveRequired.interactionId,
      expectedOrderRevision: archiveRequest.orderRevision, idempotencyKey: 'archive-submit-1',
      values: { archiveName: '授信复核-2026', conflictPolicy: 'rename', confirmed: true },
    },
  }))

  const orderDoneEvent = stream.next(event => event.activityId === 'activity-archive-review' && event.to === 'done')
  executor.complete('activity-archive-review')
  await orderDoneEvent

  const final = parseToolResult(await client.callTool({
    name: 'get_order',
    arguments: { orderId: SEED_ORDER_ID },
  }))
  assert.equal(final.order.status, 'done')
  assert.deepEqual(final.order.activities.map(activity => activity.status), [
    'done', 'done', 'done', 'done', 'done',
  ])
  assert.equal(final.order.activities[4].outputs[0].resourceId, 'resource-credit-archive')

  const duplicateFinish = await client.callTool({
    name: 'finish_activity',
    arguments: { orderId: SEED_ORDER_ID, seq: 3 },
  })
  assert.equal(duplicateFinish.isError, true, 'finishing a completed activity must be rejected')

  const revisions = stream.events.filter(event => event.type === 'activity.changed').map(event => event.rev)
  assert.deepEqual(revisions, [1, 2, 3, 6, 7, 10, 11, 14, 15, 18])
  const resetEvent = stream.next(event => event.type === 'order.reset')
  const resetResponse = await fetch(`${url}/debug/orders/${SEED_ORDER_ID}/reset`, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:3081' },
  })
  assert.equal(resetResponse.status, 200)
  assert.equal(resetResponse.headers.get('access-control-allow-origin'), '*')
  const reset = await resetResponse.json()
  assert.equal(reset.rev, 19)
  assert.equal(reset.order.status, 'ready')
  assert.deepEqual(reset.order.activities.map(activity => activity.status), [
    'pending', 'pending', 'pending', 'pending', 'pending',
  ])
  assert.equal((await resetEvent).needsHuman, false)
  assert.equal((await fetch(`${url}/debug/orders/missing/reset`, { method: 'POST' })).status, 404)
  process.stdout.write('workorder-service: multi-interaction MVP flow passed\n')
} finally {
  await client.close()
  await stream.close()
  await service.close()
  assert.equal(service.state.subscribers.size, 0)
  assert.equal(service.state.eventStreams.size, 0)
}

const productionMode = createService({ port: 0 })
const productionAddress = await productionMode.listen()
try {
  const response = await fetch(`${productionAddress.url}/debug/orders/${SEED_ORDER_ID}/reset`, { method: 'POST' })
  assert.equal(response.status, 404, 'debug reset must be absent unless the service opts in')
} finally {
  await productionMode.close()
}
