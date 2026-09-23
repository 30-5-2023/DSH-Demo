import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.ts'
import { A2AAgentClient } from './client.ts'
import { DshAgentExecutor } from './executor.ts'
import { A2AQuestionBroker } from './interaction.ts'
import { BridgeRequestHandler } from './request-handler.ts'
import { EventSessionTurnTracker } from './run-tracker.ts'
import { A2AFileLinks, StorageDomainA2AFileLinkRepository } from './file-links.ts'
import { A2AFileTransfer } from './file-transfer.ts'
import { A2AFilePublications } from './publication.ts'
import { BoundedContextScheduler } from './scheduler.ts'
import { createA2AServer, type A2AServer } from './server.ts'
import { DomainTaskStore, StorageDomainA2ARepository } from './store.ts'
import { createCallA2AAgentTool, createPublishA2AFileTool } from './tool.ts'
import type { Config as ConfigShape } from './types.ts'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'

/** Stable Cordis plugin name. */
export const name = 'business-a2a-bridge'
/** Host services required by inbound A2A execution and persistence. */
export const inject = ['webServer', 'sessionController', 'storageDomain', 'tools', 'attachments', 'fileUploads', 'userQuestions']

/**
 * Compose durable execution and host the A2A routes on the selected listener.
 * @param ctx - Host context carrying Web Server, Session Controller, and storage-domain services.
 * @param config - Deployment and Agent Card configuration.
 * @param runtime - Instance-local broker supplied by a composed bridge runtime.
 * @returns Fulfillment after startup recovery and route registration.
 */
export async function apply(
  ctx: Context,
  config: ConfigShape,
  runtime: { readonly questions?: A2AQuestionBroker } = {},
): Promise<void> {
  const resolved = resolveConfig(config, {
    host: ctx.webServer.host,
    port: ctx.webServer.port,
    env: process.env,
  })
  await ctx.effect(async () => {
    const scheduler = new BoundedContextScheduler(resolved.maxConcurrentContexts)
    const tracker = new EventSessionTurnTracker(ctx)
    const questions = runtime.questions ?? new A2AQuestionBroker()
    let repository: StorageDomainA2ARepository | undefined
    let fileLinkRepository: StorageDomainA2AFileLinkRepository | undefined
    let server: A2AServer | undefined
    let unregisterTool: (() => unknown) | undefined
    let unregisterQuestion: (() => unknown) | undefined
    try {
      unregisterQuestion = ctx.on('user-questions/request', (request, next) => questions.answer(request, next))
      repository = await StorageDomainA2ARepository.open(ctx.storageDomain)
      fileLinkRepository = await StorageDomainA2AFileLinkRepository.open(ctx.storageDomain)
      const fileLinks = new A2AFileLinks(fileLinkRepository, {
        publicBaseUrl: resolved.publicBaseUrl,
        route: resolved.route,
        retentionMs: resolved.fileRetentionMs,
      })
      await fileLinks.reapExpired()
      await repository.markInterruptedTasksFailed(new Date().toISOString())
      const fileTransfer = new A2AFileTransfer({
        attachments: ctx.attachments,
        fileUploads: ctx.fileUploads,
        maxFileBytes: resolved.maxFileBytes,
        inlineFileMaxBytes: resolved.inlineFileMaxBytes,
        fetchTimeoutMs: resolved.requestTimeoutMs,
        maxRedirects: 4,
        publishFileAllowedRoots: resolved.publishFileAllowedRoots,
        ...(resolved.listener === undefined ? {} : { fileLinks }),
      })
      const allowedFileOrigins = new Set(resolved.fileUrlAllowedOrigins)
      const publications = new A2AFilePublications()
      const executor = new DshAgentExecutor({
        repository,
        scheduler,
        tracker,
        sessionController: ctx.sessionController,
        fileTransfer,
        fileUrlAllowedOrigin: url => allowedFileOrigins.has(url.origin),
        publications,
        requestTimeoutMs: resolved.requestTimeoutMs,
        ...(resolved.agentPreset === undefined ? {} : { agentPreset: resolved.agentPreset }),
      })
      const handler = new BridgeRequestHandler(
        resolved.agentCard,
        new DomainTaskStore(repository),
        executor,
        repository,
      )
      server = await createA2AServer(ctx, resolved, handler, {
        async handle(token, method, signal) {
          const resolution = await fileLinks.resolve(token)
          if (resolution.kind === 'missing') return { status: 404 }
          if (resolution.kind === 'expired') return { status: 410 }
          return {
            status: 200,
            record: resolution.record,
            ...(method === 'HEAD'
              ? {}
              : { body: ctx.attachments.readFileStream(resolution.record.ref, signal) }),
          }
        },
      })
      const client = new A2AAgentClient({
        maxTimeoutMs: resolved.outboundTimeoutMs,
        maxResponseBytes: resolved.maxResponseBytes,
        maxRedirects: 4,
        cancelTimeoutMs: resolved.outboundTimeoutMs,
        fileTransfer,
        fileUrlAllowedOrigins: resolved.fileUrlAllowedOrigins,
      })
      const toolDisposers: (() => unknown)[] = []
      unregisterTool = combineDisposers(toolDisposers)
      toolDisposers.push(ctx.tools.register(createCallA2AAgentTool(client, resolved.outboundTimeoutMs)))
      toolDisposers.push(ctx.tools.register(createPublishA2AFileTool(publications, fileTransfer)))
    } catch (error: unknown) {
      try {
        await closeRuntime(unregisterQuestion, questions, unregisterTool, server, scheduler, tracker, repository, fileLinkRepository)
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, ...flattenErrors(cleanupError)],
          'business-a2a-bridge startup and cleanup failed',
        )
      }
      throw error
    }

    return async () => {
      await closeRuntime(unregisterQuestion, questions, unregisterTool, server, scheduler, tracker, repository, fileLinkRepository)
    }
  }, 'business-a2a-bridge.runtime')
}

async function closeRuntime(
  unregisterQuestion: (() => unknown) | undefined,
  questions: A2AQuestionBroker,
  unregisterTool: (() => unknown) | undefined,
  server: A2AServer | undefined,
  scheduler: BoundedContextScheduler,
  tracker: EventSessionTurnTracker,
  repository: StorageDomainA2ARepository | undefined,
  fileLinkRepository: StorageDomainA2AFileLinkRepository | undefined,
): Promise<void> {
  const listener = await Promise.allSettled([Promise.resolve().then(() => unregisterQuestion?.())])
  const results = await Promise.allSettled([
    Promise.resolve().then(() => unregisterTool?.()),
    closeBridge(questions, server, scheduler, tracker, repository, fileLinkRepository),
  ])
  const failures = [...listener, ...results]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'business-a2a-bridge runtime cleanup failed')
}

async function closeBridge(
  questions: A2AQuestionBroker,
  server: A2AServer | undefined,
  scheduler: BoundedContextScheduler,
  tracker: EventSessionTurnTracker,
  repository: StorageDomainA2ARepository | undefined,
  fileLinkRepository: StorageDomainA2AFileLinkRepository | undefined,
): Promise<void> {
  const results = await Promise.allSettled([
    ...(server === undefined ? [] : [server.close()]),
    questions.close(),
    scheduler.close(),
  ])
  results.push(...await Promise.allSettled([
    tracker.close(),
    ...(fileLinkRepository === undefined ? [] : [fileLinkRepository.close()]),
    ...(repository === undefined ? [] : [repository.close()]),
  ]))
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'business-a2a-bridge cleanup failed')
}

function flattenErrors(error: unknown): unknown[] {
  if (!(error instanceof AggregateError)) return [error]
  return error.errors.flatMap(flattenErrors)
}

function combineDisposers(disposers: readonly (() => unknown)[]): () => void {
  return () => {
    const failures: unknown[] = []
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'business-a2a-bridge tool cleanup failed')
  }
}

export { buildAgentCard } from './card.ts'
export { A2AAgentClient } from './client.ts'
export { Config, resolveConfig }
export { a2aMessageToPrompt, assistantTextToArtifact, safeA2AFailure } from './conversion.ts'
export { DshAgentExecutor }
export { BridgeRequestHandler }
export { createA2AServer }
export type { A2AServer }
export { createA2AHttpApplication } from './http-app.ts'
export type { A2AHttpApplication } from './http-app.ts'
export { EventSessionTurnTracker }
export {
  A2AQuestionBroker,
  A2A_INPUT_REQUIRED_SCHEMA,
  A2A_INPUT_RESPONSE_SCHEMA,
  createInputRequiredMessage,
  parseInteractionAnswer,
} from './interaction.ts'
export { A2AFileTransfer, boundedBytes, mediaTypeOrDefault, safeFileName } from './file-transfer.ts'
export type { A2AFileTransferOptions } from './file-transfer.ts'
export { A2AFileLinks, a2aBridgeFileLinksDomain, StorageDomainA2AFileLinkRepository } from './file-links.ts'
export type { A2AFileLinkResolution, A2AFileLinksOptions } from './file-links.ts'
export { createBoundedFetch, createStreamingBoundedFetch } from './safe-fetch.ts'
export { BoundedContextScheduler }
export { a2aBridgeDomain, isTerminalTask } from './store.ts'
export { DomainTaskStore, StorageDomainA2ARepository }
export { createCallA2AAgentTool, createPublishA2AFileTool } from './tool.ts'
export { A2ABridgeError, A2AContextId, A2AFileToken, A2AMessageId, A2ATaskId } from './types.ts'
export type {
  A2AAgentConfig,
  A2AInteractionError,
  A2AQuestionWindow,
  A2AQuestionWindowOptions,
  A2AAgentClientOptions,
  A2AInboundFileTransfer,
  A2AMaterializedFile,
  A2AOutboundFileInput,
  A2APublicationTarget,
  A2APublicationWindow,
  A2ABridgeErrorCode,
  A2AContextRecord,
  A2ADeployment,
  A2AFileLinkRecord,
  A2AFileLinkRepository,
  A2AFileDownloadHandler,
  A2AFilePublicationRegistry,
  A2AListenerConfig,
  A2APromptAdmission,
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
  StoredA2AFile,
  PublishedA2AFile,
  ParsedInteractionAnswer,
  TrackedSessionTurn,
  UserContent,
} from './types.ts'
export { A2AFilePublications } from './publication.ts'
