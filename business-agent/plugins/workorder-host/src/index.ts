import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'business-workorder-host'

/**
 * Mount the Task 2 Host startup marker.
 * @param ctx Cordis plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    console.log('business-workorder-host: ready')
    return () => {}
  }, 'business-workorder-host: startup marker')
}
