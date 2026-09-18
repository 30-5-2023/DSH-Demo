import { orderView } from './domain.js'
import { resetOrder } from './operations.js'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function corsOrigin(request, allowedOrigins) {
  const origin = request.headers.origin
  if (allowedOrigins.has('*')) return '*'
  return typeof origin === 'string' && allowedOrigins.has(origin) ? origin : null
}

function writeCors(response, origin) {
  if (origin === null) return
  response.setHeader('access-control-allow-origin', origin)
  response.setHeader('vary', 'origin')
}

function sendJson(response, status, body, origin) {
  writeCors(response, origin)
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(body))
}

/**
 * Handle the MVP health and order snapshot endpoints.
 * @param {object} state Service state.
 * @param {object} request Node request.
 * @param {object} response Node response.
 * @param {URL} url Parsed request URL.
 * @param {Set<string>} allowedOrigins Allowed browser development origins.
 * @param {boolean} debugEnabled Whether debug-only mutation endpoints are enabled.
 * @returns {boolean} Whether the request was handled.
 */
export function handleHttp(state, request, response, url, allowedOrigins, debugEnabled = false) {
  const origin = corsOrigin(request, allowedOrigins)
  if (request.method === 'OPTIONS') {
    if (origin === null) {
      sendJson(response, 403, { error: 'origin-not-allowed' }, null)
    } else {
      writeCors(response, origin)
      response.writeHead(204, {
        'access-control-allow-methods': debugEnabled ? 'GET, POST, OPTIONS' : 'GET, OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      response.end()
    }
    return true
  }

  const debugMatch = /^\/debug\/orders\/(?<orderId>[^/]+)\/reset$/.exec(url.pathname)
  if (debugEnabled && request.method === 'POST' && debugMatch !== null) {
    const orderId = decodeURIComponent(debugMatch.groups.orderId)
    if (!state.orders.has(orderId)) {
      sendJson(response, 404, { error: 'order-not-found', orderId }, origin)
    } else {
      sendJson(response, 200, resetOrder(state, orderId), origin)
    }
    return true
  }

  if (request.method !== 'GET') return false

  if (url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      service: '@deepseek-ai/dsh-business-workorder-service',
      rev: state.rev,
      orders: state.orders.size,
    }, origin)
    return true
  }

  const match = /^\/orders\/(?<orderId>[^/]+)$/.exec(url.pathname)
  if (match === null) return false
  const orderId = decodeURIComponent(match.groups.orderId)
  const order = state.orders.get(orderId)
  if (order === undefined) {
    sendJson(response, 404, { error: 'order-not-found', orderId }, origin)
  } else {
    sendJson(response, 200, { rev: state.rev, order: orderView(order) }, origin)
  }
  return true
}

/**
 * Handle one server-sent event subscription.
 * @param {object} state Service state.
 * @param {object} request Node request.
 * @param {object} response Node response.
 * @param {URL} url Parsed request URL.
 * @param {Set<string>} allowedOrigins Allowed browser development origins.
 * @returns {boolean} Whether the request was handled.
 */
export function handleEvents(state, request, response, url, allowedOrigins) {
  if (url.pathname !== '/events') return false
  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET' })
    response.end()
    return true
  }
  const origin = corsOrigin(request, allowedOrigins)
  writeCors(response, origin)
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  response.write(`event: ready\ndata: ${JSON.stringify({ type: 'ready', rev: state.rev })}\n\n`)

  const orderId = url.searchParams.get('orderId')
  const send = (event) => {
    if (orderId !== null && event.orderId !== orderId) return
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  state.subscribers.add(send)
  state.eventStreams.add(response)
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    state.subscribers.delete(send)
    state.eventStreams.delete(response)
  }
  request.once('close', cleanup)
  request.once('error', cleanup)
  response.once('close', cleanup)
  return true
}
