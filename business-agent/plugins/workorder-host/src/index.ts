import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WorkorderBindings, bindingCandidate } from './bindings.ts'
import { WorkorderEventConsumer } from './events.ts'
import { WorkorderWakeCoordinator, WorkorderWakeTraceFeed } from './wake.ts'

export * from './bindings.ts'
export * from './events.ts'
export * from './wake.ts'

/** Stable Cordis plugin name. */
export const name = 'business-workorder-host'
/** Services required for native-tool observation and live-Agent delivery. */
export const inject = ['tools', 'agents']

/** Host-side work-order event and wake policy. */
export interface Config {
  /** Base URL of the business work-order service. */
  serviceUrl: string
  /** Active turns an order may open before claimed human input refills the budget. */
  maxConsecutiveWakes: number
  /** First reconnect delay after an SSE failure. */
  reconnectInitialDelayMs: number
  /** Upper bound for exponential SSE reconnect delay. */
  reconnectMaxDelayMs: number
}

/** Validated Host plugin configuration. */
export const Config: z<Config> = z.object({
  serviceUrl: z.string().required(),
  maxConsecutiveWakes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3),
  reconnectInitialDelayMs: z.number().step(1).min(1).max(60_000).default(500),
  reconnectMaxDelayMs: z.number().step(1).min(1).max(300_000).default(10_000),
})

function eventsUrl(serviceUrl: string): string {
  const url = new URL(serviceUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('business-workorder-host: serviceUrl must use HTTP or HTTPS')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('business-workorder-host: serviceUrl must not contain credentials')
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/events`
  url.search = ''
  url.hash = ''
  return url.href
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Process-local work-order bindings owned by the business Host plugin. */
    businessWorkorders: WorkorderBindings
    /** Process-local development observations of wake-routing decisions. */
    businessWorkorderWakeTraces: WorkorderWakeTraceFeed
  }
}

/**
 * Observe work-order tools, consume blocking events, and deliver bounded Agent wakes.
 * @param ctx Cordis context carrying Tool and Agent registries.
 * @param config Validated service and wake policy.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.reconnectInitialDelayMs > config.reconnectMaxDelayMs) {
    throw new Error('business-workorder-host: reconnectInitialDelayMs must not exceed reconnectMaxDelayMs')
  }
  const bindings = new WorkorderBindings()
  const wakeTraces = new WorkorderWakeTraceFeed(error => {
    ctx.logger.warn(`business-workorder-host: wake trace observer failed: ${String(error)}`)
  })
  const coordinator = new WorkorderWakeCoordinator(
    bindings,
    sessionId => ctx.agents.get(sessionId),
    config.maxConsecutiveWakes,
    trace => wakeTraces.publish(trace),
  )
  ctx.provide('businessWorkorders', bindings)
  ctx.provide('businessWorkorderWakeTraces', wakeTraces)

  ctx.on('tools/result', (exec, result) => {
    const candidate = bindingCandidate(exec, result)
    if (candidate === undefined || !bindings.bind(candidate)) return
    coordinator.bindingChanged(candidate.orderId)
  })
  ctx.on('agent/created', ({ agent }) => {
    bindings.agentCreated(agent)
    coordinator.agentAvailable(agent.id)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    bindings.agentDisposed(agent)
  })
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (message.source.kind === 'user') coordinator.humanInput(agent.id)
  })

  const consumer = new WorkorderEventConsumer({
    eventsUrl: eventsUrl(config.serviceUrl),
    reconnectInitialDelayMs: config.reconnectInitialDelayMs,
    reconnectMaxDelayMs: config.reconnectMaxDelayMs,
    onEvent: event => coordinator.accept(event),
    onError: error => ctx.logger.warn(`business-workorder-host: SSE connection failed: ${String(error)}`),
  })
  ctx.effect(() => {
    consumer.start()
    return () => consumer.stop()
  }, 'business-workorder-host.events')
}
