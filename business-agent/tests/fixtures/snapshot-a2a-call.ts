import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { Role, TaskState, type Message, type Task } from '@a2a-js/sdk'
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
  A2AFilePublications,
  createCallA2AAgentTool,
  createPublishA2AFileTool,
} from '@deepseek-ai/dsh-business-a2a-bridge'
import express from 'express'

const SENTINEL_CARD_URL = 'http://a2a-snapshot.invalid/.well-known/agent-card.json'
const SNAPSHOT_TASK_ID = 'snapshot-task'

/** Snapshot-only composition plugin name. */
export const name = 'business-a2a-call-snapshot'
/** Tool Runtime required to register the outbound A2A tool. */
export const inject = ['tools']

class SnapshotExecutor implements AgentExecutor {
  /**
   * Ask one structured question, then complete that same Task from its structured answer.
   * @param request - Parsed A2A request carrying the caller's context and optional Task identifier.
   * @param events - Execution event bus for the protocol response.
   */
  async execute(request: RequestContext, events: ExecutionEventBus): Promise<void> {
    if (request.userMessage.taskId !== SNAPSHOT_TASK_ID) {
      const pending = this.questionTask(request)
      events.publish(AgentEvent.task({
        ...pending,
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          message: undefined,
          timestamp: '2026-09-23T00:00:00.000Z',
        },
      }))
      events.publish(AgentEvent.statusUpdate({
        taskId: SNAPSHOT_TASK_ID,
        contextId: request.contextId,
        status: pending.status,
        metadata: undefined,
      }))
      return
    }

    events.publish(AgentEvent.task({
      id: SNAPSHOT_TASK_ID,
      contextId: request.contextId,
      status: {
        state: TaskState.TASK_STATE_WORKING,
        message: undefined,
        timestamp: '2026-09-23T00:00:01.000Z',
      },
      artifacts: request.task?.artifacts ?? [],
      history: request.task?.history ?? [request.userMessage],
      metadata: undefined,
    }))
    events.publish(AgentEvent.artifactUpdate({
      taskId: SNAPSHOT_TASK_ID,
      contextId: request.contextId,
      artifact: {
        artifactId: 'snapshot-result',
        name: 'snapshot-result',
        description: '',
        parts: [{
          content: { $case: 'text', value: 'snapshot approved' },
          metadata: undefined,
          filename: '',
          mediaType: 'text/plain',
        }],
        metadata: undefined,
        extensions: [],
      },
      append: false,
      lastChunk: true,
      metadata: undefined,
    }))
    events.publish(AgentEvent.statusUpdate({
      taskId: SNAPSHOT_TASK_ID,
      contextId: request.contextId,
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        message: undefined,
        timestamp: '2026-09-23T00:00:02.000Z',
      },
      metadata: undefined,
    }))
  }

  private questionTask(request: RequestContext): Task {
    const message: Message = {
      messageId: 'snapshot-question',
      contextId: request.contextId,
      taskId: SNAPSHOT_TASK_ID,
      role: Role.ROLE_AGENT,
      parts: [
        {
          content: { $case: 'text', value: 'Choose snapshot approval.' },
          metadata: undefined,
          filename: '',
          mediaType: 'text/plain',
        },
        {
          content: {
            $case: 'data',
            value: {
              schema: 'urn:deepseek-harness:a2a:input-required:v1',
              questions: [{
                id: 'approval',
                question: 'Choose snapshot approval.',
                options: [{ label: 'Approve' }, { label: 'Reject' }],
              }],
            },
          },
          metadata: undefined,
          filename: '',
          mediaType: 'application/json',
        },
      ],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    }
    return {
      id: SNAPSHOT_TASK_ID,
      contextId: request.contextId,
      status: {
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        message,
        timestamp: '2026-09-23T00:00:00.000Z',
      },
      artifacts: [],
      history: [request.userMessage],
      metadata: undefined,
    }
  }

  /**
   * Reject cancellation because the authored scenario never cancels its fixed Task.
   * @param _taskId - Unused protocol Task identifier.
   * @param _events - Unused execution event bus.
   */
  async cancelTask(_taskId: string, _events: ExecutionEventBus): Promise<void> {
    throw new Error('snapshot A2A fixture has no cancellable tasks')
  }
}

/**
 * Mount a deterministic remote A2A server and register both production A2A tool schemas.
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
    const unregister: (() => void)[] = []
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
      unregister.push(ctx.tools.register(createCallA2AAgentTool(client, 5_000)))
      unregister.push(ctx.tools.register(createPublishA2AFileTool(new A2AFilePublications(), {
        snapshotLocal: async () => { throw new Error('snapshot publish tool is schema-only') },
      })))
      return async () => {
        for (const dispose of unregister.reverse()) dispose()
        await close(server)
      }
    } catch (error: unknown) {
      for (const dispose of unregister.reverse()) dispose()
      await close(server)
      throw error
    }
  }, 'business-a2a-call-snapshot: remote server and A2A tools')
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
