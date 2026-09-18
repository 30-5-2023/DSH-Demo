/** Host bootstrap for development-only work-order controls. */

import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type { WorkorderWakeTrace } from '@deepseek-ai/dsh-business-workorder-host'
import {
  WORKORDER_WAKE_TRACE_PATH,
  type WorkorderWakeTraceRecord,
  type WorkorderWakeTraceSnapshot,
} from './protocol.ts'

export * from './protocol.ts'

/** Stable Cordis plugin name. */
export const name = 'business-workorder-debug'
/** Host services required by development trace delivery. */
export const inject = ['webServer', 'businessWorkorderWakeTraces']

type TraceResponse = Parameters<WebRoute['handler']>[1]

/** Mock service target exposed to the browser debug plugin. */
export interface Config {
  /** Base URL of the debug-enabled mock work-order service. */
  serviceUrl: string
  /** Resettable mock work-order identifier. */
  orderId: string
  /** Maximum wake-routing observations retained in process memory. */
  traceLimit: number
}

/** Validated Host plugin configuration. */
export const Config: z<Config> = z.object({
  serviceUrl: z.string().required(),
  orderId: z.string().required(),
  traceLimit: z.number().step(1).min(1).max(1_000).default(100),
})

type BrowserConfig = Pick<Config, 'serviceUrl' | 'orderId'>

function browserConfig(config: Config): BrowserConfig {
  const url = new URL(config.serviceUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('business-workorder-debug: serviceUrl must use HTTP or HTTPS')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('business-workorder-debug: serviceUrl must not contain credentials, query, or fragment')
  }
  if (config.orderId.trim() === '') throw new Error('business-workorder-debug: orderId must not be empty')
  url.pathname = url.pathname.replace(/\/$/, '')
  return { serviceUrl: url.href.replace(/\/$/, ''), orderId: config.orderId }
}

function sse(event: string, value: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`
}

function openTraceStream(response: TraceResponse, snapshot: WorkorderWakeTraceSnapshot): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  })
  response.write(sse('snapshot', snapshot))
}

/**
 * Inject the debug-enabled mock target into each served page.
 * @param ctx Host context publishing Web index injections.
 * @param config Mock service selection.
 */
export function apply(ctx: Context, config: Config): void {
  const value = browserConfig(config)
  const traces: WorkorderWakeTraceRecord[] = []
  const streams = new Set<TraceResponse>()
  let sequence = 0

  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push({ kind: 'global', name: '__DSH_BUSINESS_WORKORDER_DEBUG__', value })
  })
  ctx.effect(() => ctx.businessWorkorderWakeTraces.subscribe((trace: WorkorderWakeTrace) => {
    if (trace.event.orderId !== config.orderId) return
    const record = { ...trace, sequence: sequence += 1, observedAt: new Date().toISOString() }
    traces.push(record)
    if (traces.length > config.traceLimit) traces.splice(0, traces.length - config.traceLimit)
    const frame = sse('trace', record)
    for (const response of streams) {
      try {
        response.write(frame)
      } catch (error) {
        streams.delete(response)
        response.destroy(error instanceof Error ? error : undefined)
      }
    }
  }), 'business-workorder-debug: wake trace subscription')

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: WORKORDER_WAKE_TRACE_PATH,
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        openTraceStream(response, { limit: config.traceLimit, traces })
        streams.add(response)
        response.on('close', () => { streams.delete(response) })
      },
    })
    return () => {
      disposeRoute()
      const active = [...streams]
      streams.clear()
      for (const response of active) response.end()
    }
  }, `business-workorder-debug: GET ${WORKORDER_WAKE_TRACE_PATH}`)
}
