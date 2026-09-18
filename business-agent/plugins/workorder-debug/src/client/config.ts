/** Host-injected target consumed by the browser debug controls. */
export interface WorkorderDebugConfig {
  readonly serviceUrl: string
  readonly orderId: string
}

declare global {
  /** Debug-enabled mock work-order service selection injected by the Host plugin. */
  var __DSH_BUSINESS_WORKORDER_DEBUG__: unknown
}

let configured: WorkorderDebugConfig | undefined

/**
 * Validate and retain the Host-injected debug configuration.
 * @param value Untrusted value read from the page global.
 */
export function configureWorkorderDebug(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('business-workorder-debug: Host bootstrap is missing')
  }
  const { serviceUrl, orderId } = value as Record<string, unknown>
  if (typeof serviceUrl !== 'string' || typeof orderId !== 'string' || orderId === '') {
    throw new Error('business-workorder-debug: invalid Host bootstrap')
  }
  const url = new URL(serviceUrl)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('business-workorder-debug: invalid service URL')
  }
  configured = { serviceUrl: url.href.replace(/\/$/, ''), orderId }
}

/** @returns Validated mock service target after Client startup. */
export function workorderDebugConfig(): WorkorderDebugConfig {
  if (configured === undefined) throw new Error('business-workorder-debug: Client is not configured')
  return configured
}
