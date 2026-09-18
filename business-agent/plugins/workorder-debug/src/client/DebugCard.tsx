import { useCallback, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconRefreshOutline16,
  IconSettingsOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from './locales.ts'
import { workorderDebugConfig } from './config.ts'
import { WakeTracePanel } from './WakeTracePanel.tsx'
import css from './DebugCard.module.css'

type DebugCardProps = PropsLocale<'businessWorkorderDebug'>
type ResetState = 'idle' | 'working' | 'success' | 'failed'

/**
 * Render mock-only actions in a collapsible frame overlay.
 * @param props Localized slot props.
 * @returns Floating debug card.
 */
export function DebugCard({ t }: DebugCardProps): ReactNode {
  const { serviceUrl, orderId } = workorderDebugConfig()
  const [collapsed, setCollapsed] = useState(true)
  const [resetState, setResetState] = useState<ResetState>('idle')

  const reset = useCallback(async (): Promise<void> => {
    if (!globalThis.confirm(t('reset.confirm'))) return
    setResetState('working')
    try {
      const response = await fetch(`${serviceUrl}/debug/orders/${encodeURIComponent(orderId)}/reset`, {
        method: 'POST',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`reset request failed: ${String(response.status)}`)
      setResetState('success')
    } catch (error) {
      setResetState('failed')
      void error
    }
  }, [orderId, serviceUrl, t])

  if (collapsed) {
    return (
      <aside className={css.root} data-workorder-debug data-collapsed>
        <button
          type="button"
          className={css.collapsedTrigger}
          aria-expanded="false"
          aria-label={t('expand')}
          onClick={() => { setCollapsed(false) }}
        >
          <IconSettingsOutline16 />
          <span>{t('title')}</span>
          <IconChevronUpOutline14 />
        </button>
      </aside>
    )
  }

  const feedback = resetState === 'success'
    ? t('reset.success')
    : resetState === 'failed' ? t('reset.failed') : undefined
  return (
    <aside className={css.root} data-workorder-debug data-reset-state={resetState}>
      <header className={css.header}>
        <span className={css.identity}>
          <IconSettingsOutline16 />
          <strong>{t('title')}</strong>
          <span className={css.environment}>{t('environment')}</span>
        </span>
        <Tooltip label={t('collapse')} side="top">
          <button
            type="button"
            className={css.iconButton}
            aria-expanded="true"
            aria-label={t('collapse')}
            onClick={() => { setCollapsed(true) }}
          >
            <IconChevronDownOutline14 />
          </button>
        </Tooltip>
      </header>
      <div className={css.body}>
        <div className={css.orderRow}>
          <span>{t('order.label')}</span>
          <code>{orderId}</code>
        </div>
        <button
          type="button"
          className={css.resetButton}
          disabled={resetState === 'working'}
          onClick={() => { void reset() }}
        >
          <IconRefreshOutline16 />
          <span>{resetState === 'working' ? t('reset.working') : t('reset.action')}</span>
        </button>
        {feedback !== undefined && <p className={css.feedback} role="status">{feedback}</p>}
        <WakeTracePanel t={t} />
      </div>
    </aside>
  )
}
