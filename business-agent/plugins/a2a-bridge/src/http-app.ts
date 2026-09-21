import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import type { A2ARequestHandler } from '@a2a-js/sdk/server'
import { UserBuilder, agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express'
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import type { ResolvedA2AConfig } from './types.ts'

/** Private A2A route application with quiescent response tracking. */
export interface A2AHttpApplication {
  readonly dispatch: RequestListener
  /** Stop admitting requests and wait for every admitted response to close. */
  close(): Promise<void>
}

/**
 * Build the private A2A Express application independently of its listener.
 * @param config - Validated routes, authentication, and body limits.
 * @param handler - Request handler implementing the approved A2A operations.
 * @returns Dispatch and quiescent close operations for a hosting adapter.
 */
export function createA2AHttpApplication(
  config: ResolvedA2AConfig,
  handler: A2ARequestHandler,
): A2AHttpApplication {
  const app = express()
  const legacyCompat = { enabled: true } as const
  const card = agentCardHandler({ agentCardProvider: handler, legacyCompat })
  const rpc = jsonRpcHandler({
    requestHandler: handler,
    userBuilder: UserBuilder.noAuthentication,
    legacyCompat,
  })

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
  let accepting = true
  let closing: Promise<void> | undefined
  const dispatch = (request: IncomingMessage, response: ServerResponse): void => {
    if (!accepting) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'server closing' }))
      return
    }

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
  }

  return {
    dispatch,
    close() {
      if (closing !== undefined) return closing
      accepting = false
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
