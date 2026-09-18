import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCheckOutline16,
  IconChecklistOutline14,
  IconClockOutline16,
  IconRefreshOutline16,
  IconWarningOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from './locales.ts'
import { workorderClientConfig } from './config.ts'
import {
  parseEventRevision,
  parseOrderSnapshot,
  type WorkorderActivity,
  type WorkorderActivityStatus,
  type WorkorderSnapshot,
  type WorkorderStatus,
} from './workorder-data.ts'
import css from './WorkorderBody.module.css'

type WorkorderBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'businessWorkorder'>

type ViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly snapshot: WorkorderSnapshot; readonly connected: boolean }

function statusLabel(status: WorkorderStatus | WorkorderActivityStatus, t: WorkorderBodyProps['t']): string {
  return t(`status.${status}`)
}

function ActivityIcon({ status }: { status: WorkorderActivityStatus }): ReactNode {
  if (status === 'done') return <IconCheckOutline16 />
  if (status === 'waiting') return <IconWarningOutline16 />
  if (status === 'running') return <IconClockOutline16 />
  return <IconChecklistOutline14 />
}

function ResourceList({ label, resources, empty }: {
  label: string
  resources: WorkorderActivity['outputs']
  empty?: string
}): ReactNode {
  return (
    <div className={css.resources}>
      <span className={css.resourceLabel}>{label}</span>
      {resources.length === 0
        ? <span className={css.resourceEmpty}>{empty}</span>
        : resources.map(item => <span className={css.resource} key={item.resourceId}>{item.name}</span>)}
    </div>
  )
}

function ActivityRow({ activity, current, t }: {
  activity: WorkorderActivity
  current: boolean
  t: WorkorderBodyProps['t']
}): ReactNode {
  return (
    <li className={css.activity} data-status={activity.status} data-current={current || undefined}>
      <span className={css.activityRail} aria-hidden="true">
        <span className={css.activityIcon}><ActivityIcon status={activity.status} /></span>
      </span>
      <div className={css.activityMain}>
        <div className={css.activityHeading}>
          <span className={css.sequence}>{String(activity.seq).padStart(2, '0')}</span>
          <h3 className={css.activityTitle}>{activity.title}</h3>
          <span className={css.activityStatus}>{statusLabel(activity.status, t)}</span>
        </div>
        <div className={css.activityMeta}>
          <span>{activity.automation === 'auto' ? t('activity.automatic') : t('activity.manual')}</span>
          {current && <span className={css.current}>{t('activity.current')}</span>}
          {activity.needsHuman && <span className={css.needsHuman}>{t('activity.waiting')}</span>}
        </div>
        {activity.inputs.length > 0 && <ResourceList label={t('activity.inputs')} resources={activity.inputs} />}
        {(activity.outputs.length > 0 || activity.status !== 'pending') && (
          <ResourceList label={t('activity.outputs')} resources={activity.outputs} empty={t('activity.noOutputs')} />
        )}
      </div>
    </li>
  )
}

/**
 * Render the read-only work-order body registered in the right Sidebar.
 * @param props Slot runtime and locale props.
 * @returns Work-order status panel.
 */
export function WorkorderBody({ useTabInfo, t }: WorkorderBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const { serviceUrl, orderId } = workorderClientConfig()
  const [state, setState] = useState<ViewState>({ kind: 'loading' })
  const snapshotRef = useRef<WorkorderSnapshot>()
  const loadingRef = useRef(false)
  const reloadQueuedRef = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    if (loadingRef.current) {
      reloadQueuedRef.current = true
      return
    }
    loadingRef.current = true
    try {
      const response = await fetch(`${serviceUrl}/orders/${encodeURIComponent(orderId)}`, {
        cache: 'no-store',
        signal: tab.signal,
      })
      if (!response.ok) throw new Error(`order request failed: ${response.status}`)
      const snapshot = parseOrderSnapshot(await response.json())
      snapshotRef.current = snapshot
      setState(current => ({
        kind: 'ready',
        snapshot,
        connected: current.kind === 'ready' ? current.connected : false,
      }))
    } catch (error) {
      if (tab.signal.aborted) return
      if (snapshotRef.current === undefined) setState({ kind: 'failed' })
      void error
    } finally {
      loadingRef.current = false
      if (reloadQueuedRef.current && !tab.signal.aborted) {
        reloadQueuedRef.current = false
        void load()
      }
    }
  }, [orderId, serviceUrl, tab.signal])

  useEffect(() => {
    void load()
    const stream = new EventSource(`${serviceUrl}/events?orderId=${encodeURIComponent(orderId)}`)
    const receive = (event: MessageEvent<string>): void => {
      const revision = parseEventRevision(event.data)
      if (revision === undefined || revision <= (snapshotRef.current?.rev ?? -1)) return
      // An SSE frame is only a refresh signal. This also heals revision gaps.
      void load()
    }
    stream.onopen = () => {
      setState(current => current.kind === 'ready' ? { ...current, connected: true } : current)
    }
    stream.onerror = () => {
      setState(current => current.kind === 'ready' ? { ...current, connected: false } : current)
    }
    stream.addEventListener('ready', receive as EventListener)
    stream.onmessage = receive
    for (const type of ['activity.changed', 'order.reset']) {
      stream.addEventListener(type, receive as EventListener)
    }
    return () => { stream.close() }
  }, [load, orderId, serviceUrl])

  if (state.kind === 'loading') {
    return (
      <div className={css.center} data-workorder-state="loading">
        <IconClockOutline16 className={css.centerIcon} />
        <strong>{t('loading.title')}</strong>
        <span>{t('loading.detail')}</span>
      </div>
    )
  }
  if (state.kind === 'failed') {
    return (
      <div className={css.center} data-workorder-state="failed">
        <IconWarningOutline16 className={css.errorIcon} />
        <strong>{t('error.title')}</strong>
        <span>{t('error.detail')}</span>
        <button type="button" className={css.retry} onClick={() => { void load() }}>{t('error.retry')}</button>
      </div>
    )
  }

  const { order } = state.snapshot
  const done = order.activities.filter(activity => activity.status === 'done').length
  return (
    <div className={css.root} data-workorder-state={order.status}>
      <header className={css.header}>
        <div className={css.headerIdentity}>
          <span className={css.orderId}>{order.id}</span>
          <span className={css.live} data-connected={state.connected || undefined}>
            <span className={css.liveDot} aria-hidden="true" />
            {t('connection.live')}
          </span>
        </div>
        <Tooltip label={t('refresh')} side="bottom">
          <button type="button" className={css.tool} aria-label={t('refresh')} onClick={() => { void load() }}>
            <IconRefreshOutline16 />
          </button>
        </Tooltip>
      </header>
      {!state.connected && (
        <div className={css.disconnected} role="status">
          <IconWarningOutline16 />
          <span>{t('connection.disconnected')}</span>
        </div>
      )}
      <div className={css.body}>
        <section className={css.summary} aria-labelledby="workorder-title">
          <div className={css.summaryTop}>
            <h2 id="workorder-title" className={css.orderTitle}>{order.title}</h2>
            <span className={css.orderStatus} data-status={order.status}>{statusLabel(order.status, t)}</span>
          </div>
          <div className={css.orderMeta}>
            <span>{t('order.owner')}: {order.owner}</span>
            <span>{t('order.progress', { done, total: order.activities.length })}</span>
          </div>
          <div className={css.progress} aria-hidden="true">
            <span style={{ width: `${order.activities.length === 0 ? 0 : done / order.activities.length * 100}%` }} />
          </div>
        </section>
        <ol className={css.activities}>
          {order.activities.map(activity => (
            <ActivityRow
              key={activity.id}
              activity={activity}
              current={activity.seq === order.currentActivitySeq && order.status !== 'done'}
              t={t}
            />
          ))}
        </ol>
      </div>
    </div>
  )
}
