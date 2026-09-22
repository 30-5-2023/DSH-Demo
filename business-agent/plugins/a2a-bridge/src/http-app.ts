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
    validateLegacyFileParts,
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

function validateLegacyFileParts(request: Request, response: Response, next: NextFunction): void {
  const body = request.body as unknown
  if (!isRecord(body) || (body.method !== 'message/send' && body.method !== 'message/stream')) {
    next()
    return
  }
  const params = body.params
  const message = isRecord(params) ? params.message : undefined
  const parts = isRecord(message) ? message.parts : undefined
  if (!Array.isArray(parts)) {
    next()
    return
  }
  for (const part of parts) {
    if (!isRecord(part) || part.kind !== 'file') continue
    const file = part.file
    if (!isRecord(file)) {
      invalidParams(response, body.id)
      return
    }
    const hasBytes = Object.hasOwn(file, 'bytes')
    const hasUri = Object.hasOwn(file, 'uri')
    if (hasBytes === hasUri
      || (hasBytes && (typeof file.bytes !== 'string' || !isCanonicalBase64(file.bytes)))
      || (hasUri && typeof file.uri !== 'string')) {
      invalidParams(response, body.id)
      return
    }
  }
  next()
}

function invalidParams(response: Response, id: unknown): void {
  const responseId = typeof id === 'string' || typeof id === 'number' || id === null ? id : null
  response.status(200).json({
    jsonrpc: '2.0',
    id: responseId,
    error: { code: -32602, message: 'Invalid params' },
  })
}

function isCanonicalBase64(value: string): boolean {
  return Buffer.from(value, 'base64').toString('base64') === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
