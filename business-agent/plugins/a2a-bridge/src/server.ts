import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { A2ARequestHandler } from '@a2a-js/sdk/server'
import { createA2AHttpApplication } from './http-app.ts'
import type { ResolvedA2AConfig } from './types.ts'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Hosted A2A discovery and JSON-RPC routes. */
export interface A2AServer {
  readonly cardUrl: URL
  readonly rpcUrl: URL
  /** @returns Fulfillment after route removal and every admitted response closes. */
  close(): Promise<void>
}

/**
 * Host the private A2A application on the shared Web Server or a dedicated listener.
 * @param ctx - Cordis context carrying the shared Web Server when shared mode is selected.
 * @param config - Validated route, listener, authentication, and body limits.
 * @param handler - Request handler implementing the approved A2A operations.
 * @returns Route URLs and quiescent close operation.
 */
export async function createA2AServer(
  ctx: Context,
  config: ResolvedA2AConfig,
  handler: A2ARequestHandler,
): Promise<A2AServer> {
  const application = createA2AHttpApplication(config, handler)
  if (config.listener !== undefined) return createDedicatedServer(config, application)

  const removeCard = ctx.webServer.register({
    kind: 'exact',
    path: config.cardPath,
    handler: application.dispatch,
  })
  let removeRpc: () => void
  try {
    removeRpc = ctx.webServer.register({
      kind: 'exact',
      path: config.route,
      handler: application.dispatch,
    })
  } catch (error: unknown) {
    removeCard()
    await application.close()
    throw error
  }

  let closing: Promise<void> | undefined
  return {
    cardUrl: new URL(config.cardPath, config.publicBaseUrl),
    rpcUrl: new URL(config.route, config.publicBaseUrl),
    close() {
      if (closing !== undefined) return closing
      removeRpc()
      removeCard()
      closing = application.close()
      return closing
    },
  }
}

async function createDedicatedServer(
  config: ResolvedA2AConfig,
  application: ReturnType<typeof createA2AHttpApplication>,
): Promise<A2AServer> {
  const listener = config.listener
  if (listener === undefined) throw new Error('business-a2a-bridge: dedicated listener configuration is missing')
  const server = createServer(application.dispatch)
  try {
    await listen(server, listener.host, listener.port)
  } catch (error: unknown) {
    await application.close()
    throw error
  }

  const address = server.address() as AddressInfo
  const publicBaseUrl = new URL(config.publicBaseUrl)
  if (listener.port === 0 && publicBaseUrl.port === '0') publicBaseUrl.port = String(address.port)
  let closing: Promise<void> | undefined
  return {
    cardUrl: new URL(config.cardPath, publicBaseUrl),
    rpcUrl: new URL(config.route, publicBaseUrl),
    close() {
      if (closing !== undefined) return closing
      const stopped = closeServer(server)
      const drained = application.close()
      void drained.then(
        () => { server.closeIdleConnections() },
        () => { server.closeIdleConnections() },
      )
      closing = Promise.all([stopped, drained]).then(() => undefined)
      return closing
    },
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })
}
