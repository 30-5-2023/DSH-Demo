import { setTimeout as delay } from 'node:timers/promises'
import { EventSourceParserStream } from 'eventsource-parser/stream'
import { parseWorkorderEvent, type WorkorderActivityEvent } from './wake.ts'

/** Abortable retry delay used by the event consumer. */
export type RetryWait = (delayMs: number, signal: AbortSignal) => Promise<void>

/** Dependencies and callbacks for one work-order SSE consumer. */
export interface WorkorderEventConsumerOptions {
  readonly eventsUrl: string
  readonly reconnectInitialDelayMs: number
  readonly reconnectMaxDelayMs: number
  readonly onEvent: (event: WorkorderActivityEvent) => void
  readonly onError: (error: unknown) => void
  readonly fetch?: typeof globalThis.fetch
  readonly retryWait?: RetryWait
}

const defaultRetryWait: RetryWait = async (delayMs, signal) => {
  await delay(delayMs, undefined, { signal })
}

/** Owns one reconnecting HTTP SSE stream and its cancellation lifetime. */
export class WorkorderEventConsumer {
  private controller: AbortController | undefined
  private task: Promise<void> | undefined

  /** @param options Stream endpoint, retry policy, and callbacks. */
  constructor(private readonly options: WorkorderEventConsumerOptions) {}

  /** Start consuming; repeated calls while running are no-ops. */
  start(): void {
    if (this.task !== undefined) return
    this.controller = new AbortController()
    this.task = this.run(this.controller.signal)
  }

  /** @returns Settlement after the active fetch, reader, or retry wait stops. */
  async stop(): Promise<void> {
    this.controller?.abort()
    await this.task
    this.controller = undefined
    this.task = undefined
  }

  private async run(signal: AbortSignal): Promise<void> {
    const fetcher = this.options.fetch ?? globalThis.fetch
    const retryWait = this.options.retryWait ?? defaultRetryWait
    let reconnectDelay = this.options.reconnectInitialDelayMs
    while (!signal.aborted) {
      try {
        await this.consume(fetcher, signal)
        reconnectDelay = this.options.reconnectInitialDelayMs
      } catch (error: unknown) {
        if (signal.aborted) break
        this.options.onError(error)
      }
      if (signal.aborted) break
      try {
        await retryWait(reconnectDelay, signal)
      } catch (error: unknown) {
        if (!signal.aborted) this.options.onError(error)
        break
      }
      reconnectDelay = Math.min(reconnectDelay * 2, this.options.reconnectMaxDelayMs)
    }
  }

  private async consume(fetcher: typeof globalThis.fetch, signal: AbortSignal): Promise<void> {
    const response = await fetcher(this.options.eventsUrl, {
      headers: { accept: 'text/event-stream' },
      signal,
    })
    if (!response.ok) throw new Error(`business-workorder-host: SSE request failed with HTTP ${String(response.status)}`)
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      throw new Error('business-workorder-host: SSE response has an unexpected content type')
    }
    if (response.body === null) throw new Error('business-workorder-host: SSE response has no body')
    const events = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())
    for await (const message of events) {
      if (signal.aborted || message.data === '') continue
      const parsed: unknown = JSON.parse(message.data)
      const event = parseWorkorderEvent(parsed)
      if (event !== undefined) this.options.onEvent(event)
    }
  }
}
