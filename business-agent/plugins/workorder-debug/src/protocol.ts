import type { WorkorderWakeTrace } from '@deepseek-ai/dsh-business-workorder-host'

/** Same-origin development endpoint streaming wake-routing observations. */
export const WORKORDER_WAKE_TRACE_PATH = '/debug/business-workorder/wake-traces'

/** One retained wake-routing observation delivered to the browser. */
export interface WorkorderWakeTraceRecord extends WorkorderWakeTrace {
  readonly sequence: number
  readonly observedAt: string
}

/** Initial stream frame containing the retained trace history. */
export interface WorkorderWakeTraceSnapshot {
  readonly limit: number
  readonly traces: readonly WorkorderWakeTraceRecord[]
}
