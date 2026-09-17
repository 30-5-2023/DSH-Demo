#!/usr/bin/env node
/**
 * 独立启动入口。external 模式用它把工单服务当独立进程跑。
 *
 * 用法：
 *   node bin/serve.js
 *   node bin/serve.js --port 8090 --step-ms 4000 --no-seed
 * @module workorder-service/bin/serve
 */

import { createService, DEFAULT_PORT, MCP_PATH } from '../src/index.js'

/**
 * 解析命令行参数。
 * @param argv - `process.argv.slice(2)`。
 * @returns 选项。
 */
function parseArgs(argv) {
  const options = { port: DEFAULT_PORT, stepMs: 4000, seed: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--port') options.port = Number(argv[++index])
    else if (arg === '--step-ms') options.stepMs = Number(argv[++index])
    else if (arg === '--no-seed') options.seed = false
    else if (arg === '--help' || arg === '-h') options.help = true
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  process.stdout.write(`workorder-service — 工单服务（= 业务系统；执行引擎 + 可换的执行实现）

  --port <n>       监听端口（默认 ${String(DEFAULT_PORT)}）
  --step-ms <n>    内置模拟实现的单步时长，单位毫秒（默认 4000）
  --no-seed        不灌示例工单

接口：
  GET  /health                     健康检查、引擎与执行实现状态
  GET  /orders                     工单列表
  GET  /orders/:orderId            工单详情（整条产线）
  GET  /orders/:orderId/decisions  决策记录
  GET  /events[?orderId=]          SSE 事件流
  GET  /bindings/:clientId         谁在看哪张单
  PUT  /bindings/:clientId
  POST /mcp                        MCP 工具面（streamable-http）
  POST /demo/pause | /demo/speed | /demo/fail-next   演示控制

`)
  process.exit(0)
}

const service = createService(options)
const { url } = await service.listen()
process.stdout.write(`workorder-service: ${url}  (MCP: ${url}${MCP_PATH})\n`)
process.stdout.write(`  step-ms=${String(options.stepMs)}  seed=${String(options.seed)}\n`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void service.close().then(() => process.exit(0))
  })
}
