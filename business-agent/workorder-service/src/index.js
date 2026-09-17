/**
 * 工单服务：**它就是业务系统**（今日是 mock 实现），产线状态与执行引擎都在这里。
 *
 * 服务自己决定该跑哪一步；「真去跑」落在**执行实现**那一层（`state.executor`）——
 * 引擎把活动交出去、收它的回执。demo 缺省接内置的模拟实现（见 executor.js），
 * 换成真的调用只需传入 `createService({ executor })`。
 *
 * 对外有三组接口（见 business-agent/DESIGN.md），同一个服务、同一个端口：
 *  - ① 读接口 `HTTP`：看板读数据 · 唤醒器登记绑定
 *  - ② 事件流 `SSE`：看板与唤醒器订的是同一条
 *  - ③ 工具面 `MCP`：agent 查询与推进工单
 *
 * 这一层零 DSH 依赖：它可以单独启动、单独 curl，不需要宿主。
 * @module workorder-service
 */

import { createServer as createHttpServer } from 'node:http'
import { createState } from './domain.js'
import { seedOrder, seedSecondOrder } from './seed.js'
import { startEngine } from './engine.js'
import { createSimulatedExecutor } from './executor.js'
import { handleEvents, handleHttp } from './http.js'
import { createMcpNodeHandler } from './mcp.js'

/** 默认端口。与 DSH 的 3080/3081 错开。 */
export const DEFAULT_PORT = 8090

/** MCP 的挂载路径。DSH 的 mcp-client 行把它配成 `http://127.0.0.1:8090/mcp`。 */
export const MCP_PATH = '/mcp'

/**
 * 创建（但不启动）一个工单服务实例。
 *
 * @param options - `port` 端口；`engineIntervalMs` 引擎心跳；`stepMs` 内置模拟实现的单步时长；
 *   `executor` 执行实现（缺省为模拟实现，想让活动真的跑就传自己的）；`seed` 是否灌示例工单。
 * @returns 服务句柄：`listen()` / `close()` / `state` / `url`。
 */
export function createService(options = {}) {
  const state = createState()
  // 显式接执行实现：demo 用内置模拟器，真实实现换成真的去跑活动的代码。
  state.executor = options.executor ?? createSimulatedExecutor({ stepMs: options.stepMs })
  if (options.seed !== false) {
    for (const order of [seedOrder(), seedSecondOrder()]) state.orders.set(order.id, order)
  }

  const mcpHandler = createMcpNodeHandler(state)

  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://placeholder')
    void (async () => {
      // MCP 先看，它的路径是独占的。
      if (url.pathname === MCP_PATH || url.pathname.startsWith(`${MCP_PATH}/`)) {
        await mcpHandler(request, response)
        return
      }
      if (handleEvents(state, request, response, url)) return
      if (await handleHttp(state, request, response, url)) return
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: 'not-found', path: url.pathname }))
    })().catch((error) => {
      // 未捕获的请求错误不能拖垮进程：回 500 并留着服务继续跑。
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      }
      response.end(JSON.stringify({ error: 'internal', message: String(error?.message ?? error) }))
    })
  })

  let stopEngine = null
  let port = options.port ?? DEFAULT_PORT

  return {
    state,
    get port() { return port },
    get url() { return `http://127.0.0.1:${String(port)}` },

    /**
     * 开始监听并启动引擎。
     * @param listenPort - 覆盖端口；`0` 表示由系统分配（测试用）。
     * @returns 实际监听的地址。
     */
    async listen(listenPort) {
      const target = listenPort ?? port
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(target, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (address !== null && typeof address !== 'string') port = address.port
      stopEngine = startEngine(state, { intervalMs: options.engineIntervalMs ?? 1000 })
      return { port, url: `http://127.0.0.1:${String(port)}` }
    },

    /** 停掉引擎与监听。 */
    async close() {
      stopEngine?.()
      stopEngine = null
      for (const subscriber of state.subscribers) state.subscribers.delete(subscriber)
      await new Promise((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}

export { seedOrder, seedSecondOrder } from './seed.js'
export * from './domain.js'
export * from './operations.js'
export { tick, runUntilBlocked, startEngine } from './engine.js'
export { createSimulatedExecutor, DEFAULT_STEP_MS } from './executor.js'
