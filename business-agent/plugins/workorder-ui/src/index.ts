/** Host bootstrap for the browser work-order panel. */

import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'business-workorder-ui'

/** Browser-visible work-order selection for this deployment. */
export interface Config {
  /** Base URL of the business work-order service. */
  serviceUrl: string
  /** Work order displayed by the MVP panel. */
  orderId: string
}

/** Validated Host plugin configuration. */
export const Config: z<Config> = z.object({
  serviceUrl: z.string().required(),
  orderId: z.string().required(),
})

function browserConfig(config: Config): Config {
  const url = new URL(config.serviceUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('business-workorder-ui: serviceUrl must use HTTP or HTTPS')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('business-workorder-ui: serviceUrl must not contain credentials')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('business-workorder-ui: serviceUrl must not contain a query or fragment')
  }
  url.pathname = url.pathname.replace(/\/$/, '')
  if (config.orderId.trim() === '') throw new Error('business-workorder-ui: orderId must not be empty')
  return { serviceUrl: url.href.replace(/\/$/, ''), orderId: config.orderId }
}

/**
 * Inject the validated service location and selected order into each served page.
 * @param ctx Host context publishing Web index injections.
 * @param config Browser-visible work-order selection.
 */
export function apply(ctx: Context, config: Config): void {
  const value = browserConfig(config)
  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push({ kind: 'global', name: '__DSH_BUSINESS_WORKORDER__', value })
  })
}
