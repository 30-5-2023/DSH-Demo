import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from './locales.ts'
import { useWakeTraces, type WakeTrace, type WakeTraceDecision, type WakeTraceTrigger } from './wake-traces.ts'
import css from './DebugCard.module.css'

type WakeTracePanelProps = PropsLocale<'businessWorkorderDebug'>
type Translate = WakeTracePanelProps['t']

function decisionLabel(t: Translate, decision: WakeTraceDecision): string {
  switch (decision) {
    case 'duplicate-revision': return t('trace.decision.duplicateRevision')
    case 'progress-only': return t('trace.decision.progressOnly')
    case 'already-delivered': return t('trace.decision.alreadyDelivered')
    case 'waiting-for-binding': return t('trace.decision.waitingForBinding')
    case 'waiting-for-agent': return t('trace.decision.waitingForAgent')
    case 'wake-budget-exhausted': return t('trace.decision.budgetExhausted')
    case 'followup': return t('trace.decision.followup')
    case 'inject': return t('trace.decision.inject')
    default: {
      const exhaustive: never = decision
      return exhaustive
    }
  }
}

function triggerLabel(t: Translate, trigger: WakeTraceTrigger): string {
  switch (trigger) {
    case 'service-event': return t('trace.trigger.serviceEvent')
    case 'binding-change': return t('trace.trigger.bindingChange')
    case 'agent-available': return t('trace.trigger.agentAvailable')
    case 'human-input': return t('trace.trigger.humanInput')
    default: {
      const exhaustive: never = trigger
      return exhaustive
    }
  }
}

function time(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleTimeString()
}

function TraceDetails({ t, trace }: { readonly t: Translate; readonly trace: WakeTrace }): ReactNode {
  const delivered = trace.decision === 'followup' || trace.decision === 'inject'
  return (
    <details className={css.traceItem} data-decision={trace.decision} open={delivered}>
      <summary className={css.traceSummary}>
        <span className={css.traceRevision}>R{trace.event.rev}</span>
        <span className={css.traceActivity}>{t('trace.step', { seq: trace.event.activitySeq })} · {trace.event.activityTitle}</span>
        <span className={css.traceDecision}>{decisionLabel(t, trace.decision)}</span>
        <time className={css.traceTime}>{time(trace.observedAt)}</time>
      </summary>
      <div className={css.traceDetails}>
        <dl className={css.traceFacts}>
          <div><dt>{t('trace.trigger')}</dt><dd>{triggerLabel(t, trace.trigger)}</dd></div>
          <div><dt>{t('trace.operation')}</dt><dd>{decisionLabel(t, trace.decision)}</dd></div>
          {trace.sessionId !== undefined && <div><dt>{t('trace.session')}</dt><dd><code>{trace.sessionId}</code></dd></div>}
          {trace.agentStatus !== undefined && <div><dt>{t('trace.agentStatus')}</dt><dd><code>{trace.agentStatus}</code></dd></div>}
        </dl>
        <p className={css.traceLabel}>{t('trace.event')}</p>
        <pre className={css.traceJson}>{JSON.stringify(trace.event, null, 2)}</pre>
        <p className={css.traceLabel}>{t('trace.agentMessage')}</p>
        {trace.message === undefined
          ? <p className={css.noMessage}>{t('trace.noAgentMessage')}</p>
          : <pre className={css.traceJson}>{JSON.stringify(trace.message, null, 2)}</pre>}
      </div>
    </details>
  )
}

/**
 * Render retained and live wake-routing observations.
 * @param props Localized slot props.
 * @returns Wake inspector section.
 */
export function WakeTracePanel({ t }: WakeTracePanelProps): ReactNode {
  const state = useWakeTraces()
  const status = state.connection === 'live'
    ? t('trace.connection.live')
    : state.connection === 'error' ? t('trace.connection.error') : t('trace.connection.connecting')
  return (
    <section className={css.tracePanel} aria-label={t('trace.title')}>
      <header className={css.traceHeader}>
        <span className={css.traceTitle}><IconCodeOutline16 /><strong>{t('trace.title')}</strong></span>
        <span className={css.traceCount}>{state.traces.length}</span>
        <span className={css.traceConnection} data-state={state.connection} role="status">{status}</span>
      </header>
      {state.traces.length === 0
        ? <p className={css.traceEmpty}>{t('trace.empty')}</p>
        : <div className={css.traceList}>{[...state.traces].reverse().map(trace => (
            <TraceDetails key={trace.sequence} t={t} trace={trace} />
          ))}</div>}
    </section>
  )
}
