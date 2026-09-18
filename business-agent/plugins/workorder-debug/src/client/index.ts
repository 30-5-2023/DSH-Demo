import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { configureWorkorderDebug } from './config.ts'
import { DebugCard } from './DebugCard.tsx'
import { en, zh } from './locales.ts'

/** This package's locale namespace. */
export const WORKORDER_DEBUG_LOCALE_NAMESPACE = 'businessWorkorderDebug'

/** Services required by the browser plugin. */
export const inject = ['slots', 'locale']

/**
 * Register development-only controls in the frame overlay.
 * @param ctx Client root context carrying slots and locale services.
 */
export function apply(ctx: ClientContext): void {
  configureWorkorderDebug(globalThis.__DSH_BUSINESS_WORKORDER_DEBUG__)
  ctx.effect(
    () => ctx.locale.register(WORKORDER_DEBUG_LOCALE_NAMESPACE, { zh, en }),
    'business-workorder-debug: dictionaries',
  )
  ctx.effect(() => ctx.slots.inject(
    'shell.overlay',
    () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'business-workorder-debug',
      order: 1_000,
      locale: WORKORDER_DEBUG_LOCALE_NAMESPACE,
    }, DebugCard),
  ), 'business-workorder-debug: floating card')
}
