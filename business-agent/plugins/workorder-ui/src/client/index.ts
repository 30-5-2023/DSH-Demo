import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { WORKORDER_ID, workorderDefinition } from './definition.tsx'
import { WorkorderBody } from './WorkorderBody.tsx'
import { en, zh } from './locales.ts'

export type { WorkorderActivity, WorkorderSnapshot } from './workorder-data.ts'
export { parseEventRevision, parseOrderSnapshot } from './workorder-data.ts'

/** This package's locale namespace. */
export const WORKORDER_LOCALE_NAMESPACE = 'businessWorkorder'

/** Services required by the browser plugin. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Register the read-only work-order page in the right Sidebar.
 * @param ctx Client root context carrying the tab registry, slots, and locale service.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(WORKORDER_LOCALE_NAMESPACE)
  ctx.effect(
    () => ctx.sidebarRightTabs.register(workorderDefinition(t)),
    'business-workorder-ui: work-order type',
  )
  ctx.effect(
    () => ctx.locale.register(WORKORDER_LOCALE_NAMESPACE, { zh, en }),
    'business-workorder-ui: dictionaries',
  )
  ctx.effect(() => ctx.slots.inject(
    'sidebar.right.pane.tab',
    () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: WORKORDER_ID, locale: WORKORDER_LOCALE_NAMESPACE },
      WorkorderBody,
    ),
  ), 'business-workorder-ui: work-order body')
}
