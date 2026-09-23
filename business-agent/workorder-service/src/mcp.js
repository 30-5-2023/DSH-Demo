import { z } from 'zod'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { orderView } from './domain.js'
import { finishActivity, requireOrder, startActivity, startOrder } from './operations.js'
import { getInteractionRequest, submitInteractionResponse } from './interactions.js'

const result = value => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
})

/**
 * Create one stateless MCP server facade over shared service state.
 * @param {object} state Service state.
 * @param {object} executor Automatic activity executor.
 * @returns {McpServer} Configured MCP server.
 */
export function createMcpServer(state, executor) {
  const server = new McpServer(
    { name: 'business-workorder', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.registerTool('get_order', {
    description: 'Read the authoritative snapshot of one business work order.',
    inputSchema: z.object({ orderId: z.string().describe('Work-order identifier') }),
  }, async ({ orderId }) => result({ rev: state.rev, order: orderView(requireOrder(state, orderId)) }))

  server.registerTool('start_order', {
    description: 'Start a ready work order. Returns immediately while automatic work continues in the background.',
    inputSchema: z.object({ orderId: z.string().describe('Work-order identifier') }),
  }, async ({ orderId }) => result(startOrder(state, orderId, executor)))

  server.registerTool('start_activity', {
    description: 'Start the current waiting manual activity.',
    inputSchema: z.object({
      orderId: z.string().describe('Work-order identifier'),
      seq: z.number().int().positive().describe('Activity sequence number'),
    }),
  }, async ({ orderId, seq }) => result(startActivity(state, orderId, seq)))

  server.registerTool('finish_activity', {
    description: 'Finish the current running manual activity.',
    inputSchema: z.object({
      orderId: z.string().describe('Work-order identifier'),
      seq: z.number().int().positive().describe('Activity sequence number'),
    }),
  }, async ({ orderId, seq }) => result(finishActivity(state, orderId, seq, executor)))

  server.registerTool('get_interaction_request', {
    description: 'Read the authoritative structured interaction request for a blocked work-order activity.',
    inputSchema: z.object({
      orderId: z.string().describe('Work-order identifier'),
      interactionId: z.string().describe('Interaction-request identifier'),
    }),
  }, async ({ orderId, interactionId }) => result(getInteractionRequest(state, orderId, interactionId)))

  server.registerTool('submit_interaction_response', {
    description: 'Submit validated user values for a pending interaction and resume its work-order activity.',
    inputSchema: z.object({
      orderId: z.string(),
      interactionId: z.string(),
      expectedOrderRevision: z.number().int().nonnegative(),
      idempotencyKey: z.string().min(1),
      values: z.record(z.string(), z.unknown()),
    }),
  }, async request => result(submitInteractionResponse(state, request, executor)))

  return server
}

/**
 * Create the Node request handler for the streamable HTTP MCP endpoint.
 * @param {object} state Service state.
 * @param {object} executor Automatic activity executor.
 * @returns {(request: object, response: object) => Promise<void>} Node handler.
 */
export function createMcpNodeHandler(state, executor) {
  return toNodeHandler(createMcpHandler(() => createMcpServer(state, executor)))
}
