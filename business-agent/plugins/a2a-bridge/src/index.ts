import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.ts'
import { A2AAgentClient } from './client.ts'
import { DshAgentExecutor } from './executor.ts'
import { BridgeRequestHandler } from './request-handler.ts'
import { EventSessionTurnTracker } from './run-tracker.ts'
import { BoundedContextScheduler } from './scheduler.ts'
import { createA2AServer, type A2AServer } from './server.ts'
import { DomainTaskStore, StorageDomainA2ARepository } from './store.ts'
import { createCallA2AAgentTool } from './tool.ts'
import type { Config as ConfigShape } from './types.ts'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-tools'

/** Stable Cordis plugin name. */
export const name = 'business-a2a-bridge'
/** Host services required by inbound A2A execution and persistence. */
export const inject = ['webServer', 'sessionController', 'storageDomain', 'tools']

/**
 * Compose durable execution and mount the A2A routes on the shared listener.
 * @param ctx - Host context carrying Web Server, Session Controller, and storage-domain services.
 * @param config - Deployment and Agent Card configuration.
 * @returns Fulfillment after startup recovery and route registration.
 */
export async function apply(ctx: Context, config: ConfigShape): Promise<void> {
  const resolved = resolveConfig(config, {
    host: ctx.webServer.host,
    port: ctx.webServer.port,
    env: process.env,
  })
  const repository = await StorageDomainA2ARepository.open(ctx.storageDomain)
  const scheduler = new BoundedContextScheduler(resolved.maxConcurrentContexts)
  const tracker = new EventSessionTurnTracker(ctx)
  let server: A2AServer | undefined
  try {
    await repository.markInterruptedTasksFailed(new Date().toISOString())
    const executor = new DshAgentExecutor({
      repository,
      scheduler,
      tracker,
      sessionController: ctx.sessionController,
      requestTimeoutMs: resolved.requestTimeoutMs,
      ...(resolved.agentPreset === undefined ? {} : { agentPreset: resolved.agentPreset }),
    })
    const handler = new BridgeRequestHandler(
      resolved.agentCard,
      new DomainTaskStore(repository),
      executor,
      repository,
    )
    server = createA2AServer(ctx, resolved, handler)
  } catch (error: unknown) {
    await closeBridge(server, scheduler, tracker, repository)
    throw error
  }

  ctx.effect(() => async () => {
    await closeBridge(server, scheduler, tracker, repository)
  }, 'business-a2a-bridge.runtime')
  const client = new A2AAgentClient({
    maxTimeoutMs: resolved.outboundTimeoutMs,
    maxResponseBytes: resolved.maxResponseBytes,
    maxRedirects: 4,
    cancelTimeoutMs: resolved.outboundTimeoutMs,
  })
  ctx.effect(
    () => ctx.tools.register(createCallA2AAgentTool(client, resolved.outboundTimeoutMs)),
    'business-a2a-bridge.call-a2a-agent',
  )
}

async function closeBridge(
  server: A2AServer | undefined,
  scheduler: BoundedContextScheduler,
  tracker: EventSessionTurnTracker,
  repository: StorageDomainA2ARepository,
): Promise<void> {
  const results = await Promise.allSettled([
    ...(server === undefined ? [] : [server.close()]),
    scheduler.close(),
  ])
  results.push(...await Promise.allSettled([tracker.close(), repository.close()]))
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'business-a2a-bridge cleanup failed')
}

export { buildAgentCard } from './card.ts'
export { A2AAgentClient } from './client.ts'
export { Config, resolveConfig }
export { a2aMessageToPrompt, assistantTextToArtifact, safeA2AFailure } from './conversion.ts'
export { DshAgentExecutor }
export { BridgeRequestHandler }
export { createA2AServer }
export type { A2AServer }
export { EventSessionTurnTracker }
export { createBoundedFetch, createStreamingBoundedFetch } from './safe-fetch.ts'
export { BoundedContextScheduler }
export { a2aBridgeDomain, isTerminalTask } from './store.ts'
export { DomainTaskStore, StorageDomainA2ARepository }
export { createCallA2AAgentTool } from './tool.ts'
export { A2ABridgeError, A2AContextId, A2AMessageId, A2ATaskId } from './types.ts'
export type {
  A2AAgentConfig,
  A2AAgentClientOptions,
  A2ABridgeErrorCode,
  A2AContextRecord,
  A2ADeployment,
  A2ARepository,
  A2ASkillConfig,
  CallA2AAgentInput,
  CallA2AAgentResult,
  Config as A2ABridgeConfig,
  ContextScheduler,
  DshAgentExecutorOptions,
  ExecutionDeadline,
  FetchPolicy,
  JsonValue,
  ResolvedA2AConfig,
  ResolvedA2AConfigCore,
  SessionTurnTracker,
  TrackedSessionTurn,
  UserContent,
} from './types.ts'
