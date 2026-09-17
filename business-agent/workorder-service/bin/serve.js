#!/usr/bin/env node
import { createService, DEFAULT_PORT, MCP_PATH } from '../src/index.js'

function parseArgs(argv) {
  const options = { port: DEFAULT_PORT, stepMs: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--port') options.port = Number(argv[++index])
    else if (argument === '--step-ms') options.stepMs = Number(argv[++index])
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid --port value')
  if (options.stepMs !== undefined && (!Number.isFinite(options.stepMs) || options.stepMs < 0)) throw new Error('Invalid --step-ms value')
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  process.stdout.write(`Business work-order service\n\n  --port <n>       Loopback port (default ${String(DEFAULT_PORT)}; 0 selects a random port)\n  --step-ms <n>    Simulated automatic activity duration\n`)
  process.exit(0)
}

const service = createService(options)
const { url } = await service.listen()
process.stdout.write(`business-workorder-service: ${url} (MCP: ${url}${MCP_PATH})\n`)

let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (closing) return
    closing = true
    void service.close().then(() => process.exit(0), error => {
      console.error(error)
      process.exit(1)
    })
  })
}
