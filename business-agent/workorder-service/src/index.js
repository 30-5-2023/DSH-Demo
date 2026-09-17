import { createServer as createHttpServer } from 'node:http'
import { createState } from './domain.js'
import { startEngine } from './engine.js'
import { createSimulatedExecutor } from './executor.js'
import { handleEvents, handleHttp } from './http.js'
import { createMcpNodeHandler } from './mcp.js'
import { seedOrder } from './seed.js'

/** Default loopback port for local development. */
export const DEFAULT_PORT = 8090
/** Streamable HTTP MCP endpoint. */
export const MCP_PATH = '/mcp'
/** Browser origins allowed by the MVP development server. */
export const DEFAULT_CORS_ORIGINS = ['http://127.0.0.1:3081', 'http://localhost:3081']

/**
 * Create an independently runnable work-order service.
 * @param {{port?: number, seed?: boolean, executor?: object, stepMs?: number, engineIntervalMs?: number, corsOrigins?: string[], now?: () => string}} options Service options.
 * @returns {object} Service handle.
 */
export function createService(options = {}) {
  const state = createState({ now: options.now })
  const executor = options.executor ?? createSimulatedExecutor({ stepMs: options.stepMs })
  const allowedOrigins = new Set(options.corsOrigins ?? DEFAULT_CORS_ORIGINS)
  if (options.seed !== false) {
    const order = seedOrder(state.now)
    state.orders.set(order.id, order)
  }

  const mcpHandler = createMcpNodeHandler(state, executor)
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://workorder.invalid')
    void (async () => {
      if (url.pathname === MCP_PATH || url.pathname.startsWith(`${MCP_PATH}/`)) {
        await mcpHandler(request, response)
        return
      }
      if (handleEvents(state, request, response, url, allowedOrigins)) return
      if (handleHttp(state, request, response, url, allowedOrigins)) return
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: 'not-found', path: url.pathname }))
    })().catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: 'internal', message: String(error?.message ?? error) }))
      } else {
        response.destroy(error instanceof Error ? error : undefined)
      }
    })
  })

  let port = options.port ?? DEFAULT_PORT
  let stopEngine = null
  return {
    state,
    executor,
    get port() { return port },
    get url() { return `http://127.0.0.1:${String(port)}` },
    /**
     * Start the listener and background engine.
     * @param {number} [listenPort] Optional port override; zero requests a random port.
     * @returns {Promise<{port: number, url: string}>} Bound address.
     */
    async listen(listenPort) {
      const target = listenPort ?? port
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error)
        server.once('error', onError)
        server.listen(target, '127.0.0.1', () => {
          server.off('error', onError)
          resolve()
        })
      })
      const address = server.address()
      if (address !== null && typeof address !== 'string') port = address.port
      stopEngine = startEngine(state, executor, {
        intervalMs: options.engineIntervalMs,
        onError: error => console.error('[business-workorder-service] engine tick failed', error),
      })
      return { port, url: `http://127.0.0.1:${String(port)}` }
    },
    /** Close timers, event streams, and the HTTP listener. @returns {Promise<void>} */
    async close() {
      stopEngine?.()
      stopEngine = null
      for (const stream of [...state.eventStreams]) stream.end()
      if (!server.listening) return
      await new Promise((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
    },
  }
}

export { createState, orderView } from './domain.js'
export { tick, startEngine } from './engine.js'
export { createSimulatedExecutor } from './executor.js'
export { OperationError, finishActivity, startActivity, startOrder } from './operations.js'
export { SEED_ORDER_ID, seedOrder } from './seed.js'
