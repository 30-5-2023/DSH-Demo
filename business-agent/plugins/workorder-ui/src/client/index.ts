import type { Context } from '@deepseek-ai/cordis'

/** Client startup currently has no service dependencies. */
export const inject: string[] = []

/**
 * Mount a DOM marker so Profile smoke tests can observe the browser half.
 * @param ctx Browser Cordis context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    document.documentElement.dataset.businessWorkorderUi = 'ready'
    return () => { delete document.documentElement.dataset.businessWorkorderUi }
  }, 'business-workorder-ui: startup marker')
}
