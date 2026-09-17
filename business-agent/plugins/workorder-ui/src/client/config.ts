/** Host-injected configuration consumed by the browser work-order panel. */
export interface WorkorderClientConfig {
  readonly serviceUrl: string
  readonly orderId: string
}

declare global {
  /** Work-order service selection injected by the Host plugin. */
  var __DSH_BUSINESS_WORKORDER__: unknown
}

let configured: WorkorderClientConfig | undefined

/**
 * Validate and retain the Host-injected browser configuration.
 * @param value Untrusted value read from the page global.
 */
export function configureWorkorderClient(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('business-workorder-ui: Host bootstrap is missing')
  }
  const { serviceUrl, orderId } = value as Record<string, unknown>
  if (typeof serviceUrl !== 'string' || typeof orderId !== 'string' || orderId === '') {
    throw new Error('business-workorder-ui: invalid Host bootstrap')
  }
  const url = new URL(serviceUrl)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('business-workorder-ui: invalid service URL')
  }
  configured = { serviceUrl: url.href.replace(/\/$/, ''), orderId }
}

/**
 * Return the validated browser configuration after Client plugin startup.
 * @returns Work-order service location and selected order.
 */
export function workorderClientConfig(): WorkorderClientConfig {
  if (configured === undefined) throw new Error('business-workorder-ui: Client is not configured')
  return configured
}
