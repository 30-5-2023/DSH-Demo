import { useEffect, useState } from 'react'
import { WORKORDER_WAKE_TRACE_PATH } from '../protocol.ts'

/** Wake decisions rendered by the development inspector. */
export type WakeTraceDecision =
  | 'duplicate-revision'
  | 'progress-only'
  | 'already-delivered'
  | 'waiting-for-binding'
  | 'waiting-for-agent'
  | 'wake-budget-exhausted'
  | 'followup'
  | 'inject'

/** Wake triggers rendered by the development inspector. */
export type WakeTraceTrigger = 'service-event' | 'binding-change' | 'agent-available' | 'human-input'

/** Validated wake-routing record received from the local Host. */
export interface WakeTrace {
  readonly sequence: number
  readonly observedAt: string
  readonly trigger: WakeTraceTrigger
  readonly decision: WakeTraceDecision
  readonly event: {
    readonly type: 'activity.changed'
    readonly rev: number
    readonly orderId: string
    readonly orderTitle: string
    readonly activityId: string
    readonly activitySeq: number
    readonly activityTitle: string
    readonly from: string
    readonly to: string
    readonly needsHuman: boolean
    readonly line: string
    readonly at: string
  }
  readonly sessionId?: string
  readonly agentStatus?: string
  readonly message?: Readonly<Record<string, unknown>>
}

/** Current state of the Host trace stream. */
export interface WakeTraceState {
  readonly connection: 'connecting' | 'live' | 'error'
  readonly traces: readonly WakeTrace[]
}

const decisions = new Set<WakeTraceDecision>([
  'duplicate-revision',
  'progress-only',
  'already-delivered',
  'waiting-for-binding',
  'waiting-for-agent',
  'wake-budget-exhausted',
  'followup',
  'inject',
])
const triggers = new Set<WakeTraceTrigger>(['service-event', 'binding-change', 'agent-available', 'human-input'])

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`business-workorder-debug: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`business-workorder-debug: ${key} must be a string`)
  return value
}

function positiveInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`business-workorder-debug: ${key} must be a positive safe integer`)
  }
  return value as number
}

function parseTrace(value: unknown): WakeTrace {
  const record = object(value, 'trace')
  const event = object(record.event, 'trace event')
  const trigger = string(record, 'trigger') as WakeTraceTrigger
  const decision = string(record, 'decision') as WakeTraceDecision
  if (!triggers.has(trigger)) throw new Error('business-workorder-debug: unknown trace trigger')
  if (!decisions.has(decision)) throw new Error('business-workorder-debug: unknown trace decision')
  if (event.type !== 'activity.changed') throw new Error('business-workorder-debug: unsupported trace event')
  if (typeof event.needsHuman !== 'boolean') {
    throw new Error('business-workorder-debug: needsHuman must be a boolean')
  }
  const message = record.message === undefined ? undefined : object(record.message, 'Agent message')
  const sessionId = record.sessionId === undefined ? undefined : string(record, 'sessionId')
  const agentStatus = record.agentStatus === undefined ? undefined : string(record, 'agentStatus')
  return {
    sequence: positiveInteger(record, 'sequence'),
    observedAt: string(record, 'observedAt'),
    trigger,
    decision,
    event: {
      type: 'activity.changed',
      rev: positiveInteger(event, 'rev'),
      orderId: string(event, 'orderId'),
      orderTitle: string(event, 'orderTitle'),
      activityId: string(event, 'activityId'),
      activitySeq: positiveInteger(event, 'activitySeq'),
      activityTitle: string(event, 'activityTitle'),
      from: string(event, 'from'),
      to: string(event, 'to'),
      needsHuman: event.needsHuman,
      line: string(event, 'line'),
      at: string(event, 'at'),
    },
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(agentStatus === undefined ? {} : { agentStatus }),
    ...(message === undefined ? {} : { message }),
  }
}

function parseSnapshot(value: unknown): { limit: number; traces: WakeTrace[] } {
  const record = object(value, 'trace snapshot')
  const limit = positiveInteger(record, 'limit')
  if (!Array.isArray(record.traces)) throw new Error('business-workorder-debug: traces must be an array')
  return { limit, traces: record.traces.map(parseTrace) }
}

/**
 * Subscribe to retained and live wake-routing observations.
 * @returns Current connection state and ordered trace records.
 */
export function useWakeTraces(): WakeTraceState {
  const [state, setState] = useState<WakeTraceState>({ connection: 'connecting', traces: [] })

  useEffect(() => {
    const source = new EventSource(WORKORDER_WAKE_TRACE_PATH)
    let limit = 1
    source.onopen = () => { setState(current => ({ ...current, connection: 'live' })) }
    source.addEventListener('snapshot', event => {
      try {
        const snapshot = parseSnapshot(JSON.parse((event as MessageEvent<string>).data) as unknown)
        limit = snapshot.limit
        setState({ connection: 'live', traces: snapshot.traces })
      } catch (error) {
        setState(current => ({ ...current, connection: 'error' }))
        void error
      }
    })
    source.addEventListener('trace', event => {
      try {
        const trace = parseTrace(JSON.parse((event as MessageEvent<string>).data) as unknown)
        setState(current => ({
          connection: 'live',
          traces: [...current.traces.filter(item => item.sequence !== trace.sequence), trace].slice(-limit),
        }))
      } catch (error) {
        setState(current => ({ ...current, connection: 'error' }))
        void error
      }
    })
    source.onerror = () => { setState(current => ({ ...current, connection: 'error' })) }
    return () => { source.close() }
  }, [])

  return state
}
