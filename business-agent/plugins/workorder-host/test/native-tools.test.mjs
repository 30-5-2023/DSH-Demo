import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createService, SEED_ORDER_ID } from '@deepseek-ai/dsh-business-workorder-service'
import * as WorkorderHost from '../lib/index.js'

const service = createService({ port: 0, stepMs: 60_000 })
const { url } = await service.listen()
const ctx = new Context()
const systemPromptFiber = await ctx.plugin(SystemPrompt)
const toolsFiber = await ctx.plugin(ToolRuntime)
const hostFiber = await ctx.plugin(WorkorderHost)
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
  const names = ['get_order', 'start_order', 'start_activity', 'finish_activity']
    .map(toolName => `mcp__workorder__${toolName}`)
  for (const toolName of names) assert.ok(tools.get(toolName), `missing native tool ${toolName}`)
  assert.equal(tools.get('start_order'), undefined)

  const primaryAgent = {}
  const success = await tools.execute({
    callId: 'business-call-1',
    name: 'mcp__workorder__start_order',
    arguments: { orderId: SEED_ORDER_ID },
    agent: primaryAgent,
    signal: new AbortController().signal,
  })
  assert.equal(success.isError, false)
  assert.deepEqual(bindings.orders(primaryAgent), [SEED_ORDER_ID])

  const failedAgent = {}
  const failed = await tools.execute({
    callId: 'business-call-2',
    name: 'mcp__workorder__get_order',
    arguments: { orderId: 'missing-order' },
    agent: failedAgent,
    signal: new AbortController().signal,
  })
  assert.equal(failed.isError, true)
  assert.deepEqual(bindings.orders(failedAgent), [])

  const nestedAgent = {}
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
  await service.close()
}
