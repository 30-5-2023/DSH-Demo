/**
 * 接口①读接口（HTTP）与接口②事件流（SSE）。
 *
 * 路径主机中立（不带 `/api` 前缀）——看板直连这些路径；真实部署要挂前缀或鉴权，
 * 是业务方部署层的事。
 * @module workorder-service/http
 */

import { orderView, summaryView } from './domain.js'
import { DEFAULT_STEP_MS } from './executor.js'

/** 允许的请求方法。服务是只读 + demo 控制，不提供业务写接口。 */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/**
 * 执行实现的对外可见状态。
 *
 * 真实实现没有演示旋钮，所以只报类型；demo 的模拟实现才报它的开关。
 * @param state - 状态容器。
 * @returns 可序列化的执行实现描述。
 */
function executorView(state) {
  const executor = state.executor
  if (executor === undefined) return { kind: 'none' }
  if (executor.kind !== 'simulated') return { kind: executor.kind }
  return { kind: 'simulated', stepMs: executor.stepMs, failNextSeq: executor.failNextSeq }
}

/**
 * 写一个 JSON 响应。
 * @param response - node:http 响应。
 * @param status - 状态码。
 * @param body - 可序列化值。
 */
function sendJson(response, status, body) {
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(body, null, 2))
}

/**
 * 读一个 JSON 请求体（带大小上限）。
 * @param request - node:http 请求。
 * @param limitBytes - 上限。
 * @returns 解析后的值，空体返回 `{}`。
 */
async function readJson(request, limitBytes = 65536) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 处理一条前端接口请求。
 *
 * 返回 false 表示这条路径不归本模块管（交给 MCP 或 404）。
 * @param state - 状态容器。
 * @param request - node:http 请求。
 * @param response - node:http 响应。
 * @param url - 解析后的 URL。
 * @returns 是否已处理。
 */
export async function handleHttp(state, request, response, url) {
  const path = url.pathname
  const method = request.method ?? 'GET'

  if (path === '/health') {
    sendJson(response, 200, {
      ok: true,
      service: 'workorder-service',
      rev: state.rev,
      orders: state.orders.size,
      subscribers: state.subscribers.size,
      engine: { paused: state.engine.paused },
      executor: executorView(state),
    })
    return true
  }

  if (path === '/orders' && method === 'GET') {
    const status = url.searchParams.get('status')
    const keyword = url.searchParams.get('q')?.toLowerCase()
    const orders = [...state.orders.values()]
      .filter(order => status === null || order.status === status)
      .filter(order => keyword === undefined || keyword === '' || order.title.toLowerCase().includes(keyword))
      .map(summaryView)
    sendJson(response, 200, { rev: state.rev, orders })
    return true
  }

  const orderMatch = /^\/orders\/(?<orderId>[^/]+)$/.exec(path)
  if (orderMatch !== null && method === 'GET') {
    const order = state.orders.get(decodeURIComponent(orderMatch.groups.orderId))
    if (order === undefined) {
      sendJson(response, 404, { error: 'order-not-found', orderId: orderMatch.groups.orderId })
      return true
    }
    sendJson(response, 200, { rev: state.rev, order: orderView(order) })
    return true
  }

  const decisionsMatch = /^\/orders\/(?<orderId>[^/]+)\/decisions$/.exec(path)
  if (decisionsMatch !== null && method === 'GET') {
    const orderId = decodeURIComponent(decisionsMatch.groups.orderId)
    if (!state.orders.has(orderId)) {
      sendJson(response, 404, { error: 'order-not-found', orderId })
      return true
    }
    sendJson(response, 200, { rev: state.rev, decisions: [...(state.decisions.get(orderId) ?? [])].reverse() })
    return true
  }

  const bindingMatch = /^\/bindings\/(?<clientId>[^/]+)$/.exec(path)
  if (bindingMatch !== null) {
    const clientId = decodeURIComponent(bindingMatch.groups.clientId)
    if (method === 'GET') {
      sendJson(response, 200, { clientId, orderId: state.bindings.get(clientId) ?? null })
      return true
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readJson(request)
      const orderId = body.orderId
      if (orderId === null || orderId === undefined) state.bindings.delete(clientId)
      else if (!state.orders.has(orderId)) {
        sendJson(response, 404, { error: 'order-not-found', orderId })
        return true
      } else state.bindings.set(clientId, orderId)
      sendJson(response, 200, { clientId, orderId: state.bindings.get(clientId) ?? null })
      return true
    }
  }

  // ── demo 控制面：真实部署里业务系统不会有这些 ──────────────────────────
  if (path.startsWith('/demo/')) {
    await handleDemo(state, request, response, url, method)
    return true
  }

  return false
}

/**
 * demo 控制面。真实实现里不存在这些端点，它们只是让演示可控。
 *
 * 这些旋钮长在**模拟执行实现**身上（多快算跑完、下一次哪步失败），所以换成真实实现时
 * 它们没有落点，直接回 409 而不是假装成功。
 * @param state - 状态容器。
 * @param request - 请求。
 * @param response - 响应。
 * @param url - URL。
 * @param method - 方法。
 */
async function handleDemo(state, request, response, url, method) {
  if (method !== 'POST') {
    sendJson(response, 405, { error: 'method-not-allowed', allow: 'POST' })
    return
  }
  const executor = state.executor
  if (executor?.kind !== 'simulated') {
    sendJson(response, 409, { error: 'executor-not-simulated', executor: executorView(state) })
    return
  }
  const body = await readJson(request)
  switch (url.pathname) {
    case '/demo/pause':
      state.engine.paused = body.paused ?? true
      break
    case '/demo/speed':
      executor.stepMs = Math.max(200, Number(body.stepMs) || DEFAULT_STEP_MS)
      break
    case '/demo/fail-next':
      executor.failNextSeq = body.seq === null || body.seq === undefined ? null : Number(body.seq)
      break
    default:
      sendJson(response, 404, { error: 'unknown-demo-endpoint', path: url.pathname })
      return
  }
  sendJson(response, 200, {
    ok: true,
    engine: { paused: state.engine.paused },
    executor: executorView(state),
  })
}

/**
 * 处理 SSE 订阅：`GET /events`。
 *
 * 事件载荷主机中立——只说产线发生了什么，不说「往会话里写一条消息」。
 * `?orderId=` 可以只订阅一张工单；缺省订阅全部。
 * @param state - 状态容器。
 * @param request - 请求。
 * @param response - 响应。
 * @param url - URL。
 * @returns 是否已处理。
 */
export function handleEvents(state, request, response, url) {
  if (url.pathname !== '/events') return false
  if ((request.method ?? 'GET') !== 'GET') {
    response.writeHead(405, { allow: 'GET' })
    response.end()
    return true
  }
  const only = url.searchParams.get('orderId')
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  // 立刻刷头，否则浏览器要等到第一帧才认为连上了。
  response.write(': connected\n\n')
  response.write(`event: ready\ndata: ${JSON.stringify({ type: 'ready', rev: state.rev })}\n\n`)

  const send = (event) => {
    if (only !== null && event.orderId !== only) return
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  state.subscribers.add(send)
  const heartbeat = setInterval(() => {
    response.write(`: ping ${String(Date.now())}\n\n`)
  }, 15000)
  heartbeat.unref?.()

  const cleanup = () => {
    clearInterval(heartbeat)
    state.subscribers.delete(send)
  }
  request.on('close', cleanup)
  request.on('error', cleanup)
  return true
}
