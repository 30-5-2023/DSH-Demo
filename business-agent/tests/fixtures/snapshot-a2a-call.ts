import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { Role, type Message } from '@a2a-js/sdk'
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server'
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
} from '@a2a-js/sdk/server/express'
import type { Context } from '@deepseek-ai/cordis'
import {
  A2AAgentClient,
  createCallA2AAgentTool,
} from '@deepseek-ai/dsh-business-a2a-bridge'
import express from 'express'

const SENTINEL_CARD_URL = 'http://a2a-snapshot.invalid/.well-known/agent-card.json'

/** Snapshot-only composition plugin name. */
export const name = 'business-a2a-call-snapshot'
/** Tool Runtime required to register the outbound A2A tool. */
export const inject = ['tools']

class SnapshotExecutor implements AgentExecutor {
  /**
   * Return one stable agent message without allocating a task identifier.
   * @param request - Parsed A2A request carrying the caller's context identifier.
   * @param events - Execution event bus for the protocol response.
   */
  async execute(request: RequestContext, events: ExecutionEventBus): Promise<void> {
    const message: Message = {
      messageId: 'snapshot-agent-message',
      contextId: request.contextId,
      taskId: '',
      role: Role.ROLE_AGENT,
      parts: [{
        content: { $case: 'text', value: 'snapshot remote reply' },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    }
    events.publish(AgentEvent.message(message))
  }

  /**
   * Reject cancellation because this fixture never creates tasks.
   * @param _taskId - Unused protocol task identifier.
   * @param _events - Unused execution event bus.
   */
  async cancelTask(_taskId: string, _events: ExecutionEventBus): Promise<void> {
    throw new Error('snapshot A2A fixture has no cancellable tasks')
  }
}

/**
 * Mount a deterministic remote A2A server and register the production outbound tool.
 * @param ctx - Snapshot composition context carrying the Tool Runtime.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(async () => {
    const app = express()
    const server = createServer(app)
    await listen(server)
    const address = server.address()
    if (address === null || typeof address === 'string') {
      await close(server)
      throw new Error('snapshot A2A fixture did not receive a TCP address')
    }
    const baseUrl = `http://127.0.0.1:${address.port}`
    let unregister: (() => void) | undefined
    try {
      const card = {
        name: 'Snapshot Remote Agent',
        description: 'Deterministic outbound A2A snapshot fixture',
        version: '1.0.0',
        provider: undefined,
        supportedInterfaces: [{
          url: `${baseUrl}/a2a`,
          protocolBinding: 'JSONRPC',
          tenant: '',
          protocolVersion: '1.0',
        }],
        capabilities: {
          streaming: true,
          pushNotifications: false,
          extensions: [],
          extendedAgentCard: false,
        },
        securitySchemes: {},
        securityRequirements: [],
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [{
          id: 'snapshot-reply',
          name: 'Snapshot reply',
          description: 'Return the deterministic snapshot response',
          tags: ['snapshot'],
          examples: [],
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
          securityRequirements: [],
        }],
        signatures: [],
      }
      const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new SnapshotExecutor())
      app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }))
      app.use('/a2a', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }))

      const client = new A2AAgentClient({
        maxTimeoutMs: 5_000,
        maxResponseBytes: 1_048_576,
        maxRedirects: 2,
        cancelTimeoutMs: 1_000,
        fetchImpl: async (input, init) => {
          const requested = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
          const target = requested.href === SENTINEL_CARD_URL
            ? new URL(`${baseUrl}${requested.pathname}${requested.search}`)
            : requested
          return await fetch(target, init)
        },
      })
      unregister = ctx.tools.register(createCallA2AAgentTool(client, 5_000))
      return async () => {
        unregister?.()
        await close(server)
      }
    } catch (error: unknown) {
      unregister?.()
      await close(server)
      throw error
    }
  }, 'business-a2a-call-snapshot: remote server and outbound tool')
}

async function listen(server: Server): Promise<void> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  server.close()
  await once(server, 'close')
}
