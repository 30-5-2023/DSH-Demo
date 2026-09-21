import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { A2ARequestHandler } from '@a2a-js/sdk/server'
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
} from '@a2a-js/sdk/server/express'
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import type { ResolvedA2AConfig } from './types.ts'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Mounted A2A discovery and JSON-RPC routes on the shared Web Server. */
export interface A2AServer {
  readonly cardUrl: URL
  readonly rpcUrl: URL
  /** @returns Fulfillment after route removal and every admitted response closes. */
  close(): Promise<void>
}

/**
 * Mount the official A2A Express handlers without opening a second listener.
 * @param ctx - Cordis context carrying the shared Web Server.
 * @param config - Validated route, authentication, and body limits.
 * @param handler - Request handler implementing the approved A2A operations.
 * @returns Route URLs and quiescent close operation.
 */
export function createA2AServer(
  ctx: Context,
  config: ResolvedA2AConfig,
  handler: A2ARequestHandler,
): A2AServer {
  const app = express()
  const card = agentCardHandler({ agentCardProvider: handler })
  const rpc = jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication })

  app.use(config.cardPath, requireMethod('GET'), card)
  app.use(
    config.route,
    requireMethod('POST'),
    authenticate(config.bearerToken),
    express.json({ limit: config.maxRequestBytes, type: 'application/json' }),
    rpc,
  )
  app.use(safeExpressError)

  const active = new Set<Promise<void>>()
  const dispatch = (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const settled = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    active.add(settled)
    let finished = false
    const complete = (): void => {
      if (finished) return
      finished = true
      response.off('finish', complete)
      response.off('close', complete)
      active.delete(settled)
      resolve()
    }
    response.once('finish', complete)
    response.once('close', complete)
    try {
      app(request as Request, response as Response)
    } catch (error: unknown) {
      active.delete(settled)
      response.off('finish', complete)
      response.off('close', complete)
      reject(error)
    }
    return settled
  }
  const removeCard = ctx.webServer.register({ kind: 'exact', path: config.cardPath, handler: dispatch })
  let removeRpc: () => void
  try {
    removeRpc = ctx.webServer.register({ kind: 'exact', path: config.route, handler: dispatch })
  } catch (error: unknown) {
    removeCard()
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
      closing = Promise.allSettled([...active]).then(() => undefined)
      return closing
    },
  }
}

function requireMethod(method: 'GET' | 'POST') {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.method === method) next()
    else response.status(405).set('allow', method).json({ error: 'method not allowed' })
  }
}

function authenticate(token: string | undefined) {
  if (token === undefined) return (_request: Request, _response: Response, next: NextFunction): void => { next() }
  const expected = Buffer.from(token)
  return (request: Request, response: Response, next: NextFunction): void => {
    const authorization = request.get('authorization')
    const supplied = authorization?.startsWith('Bearer ')
      ? Buffer.from(authorization.slice('Bearer '.length))
      : undefined
    if (supplied !== undefined && supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
      next()
      return
    }
    response.status(401).set('www-authenticate', 'Bearer').json({ error: 'unauthorized' })
  }
}

const safeExpressError: ErrorRequestHandler = (error, _request, response, _next) => {
  const status = isBodyTooLarge(error) ? 413 : 400
  response.status(status).json({ error: status === 413 ? 'request body too large' : 'invalid request body' })
}

function isBodyTooLarge(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'type' in error
    && error.type === 'entity.too.large'
}
