import { A2ABridgeError, type FetchPolicy } from './types.ts'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Create a credential-free HTTP(S) fetch wrapper with redirect, timeout, and response-byte limits. */
export function createBoundedFetch(policy: FetchPolicy): typeof fetch {
  return createPolicyFetch(policy, false)
}

/** Create a bounded HTTP(S) fetch wrapper that preserves streaming response delivery. */
export function createStreamingBoundedFetch(policy: FetchPolicy): typeof fetch {
  return createPolicyFetch(policy, true)
}

function createPolicyFetch(policy: FetchPolicy, streaming: boolean): typeof fetch {
  assertPositiveInteger(policy.timeoutMs, 'timeoutMs')
  assertPositiveInteger(policy.maxResponseBytes, 'maxResponseBytes')
  if (!Number.isSafeInteger(policy.maxRedirects) || policy.maxRedirects < 0) {
    throw new TypeError('business-a2a-bridge: maxRedirects must be a non-negative integer')
  }
  const fetchImpl = policy.fetchImpl ?? globalThis.fetch

  const boundedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const initialUrl = validateUrl(input instanceof Request ? input.url : String(input))
    let request: Request
    try {
      request = new Request(input, init)
    } catch (error) {
      throw new A2ABridgeError('A2A_FETCH_URL_REJECTED', 'Remote A2A request URL or options are invalid.', { cause: error })
    }

    let method = request.method
    let body = method === 'GET' || method === 'HEAD' || request.body === null
      ? undefined
      : new Uint8Array(await request.clone().arrayBuffer())
    let headers = new Headers(request.headers)
    let currentUrl = initialUrl
    let redirects = 0
    const timeoutSignal = AbortSignal.timeout(policy.timeoutMs)
    const callerSignals = [request.signal, ...(policy.signal === undefined ? [] : [policy.signal])]
    const callerSignal = AbortSignal.any(callerSignals)
    const signal = AbortSignal.any([callerSignal, timeoutSignal])

    try {
      for (;;) {
        const response = await fetchImpl(currentUrl, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: 'manual',
          signal,
        })
        if (!REDIRECT_STATUSES.has(response.status)) {
          return streaming
            ? await streamingBoundedResponse(response, policy.maxResponseBytes)
            : await boundedResponse(response, policy.maxResponseBytes, signal)
        }

        const location = response.headers.get('location')
        if (location === null) {
          return streaming
            ? await streamingBoundedResponse(response, policy.maxResponseBytes)
            : await boundedResponse(response, policy.maxResponseBytes, signal)
        }
        await cancelBody(response)
        if (redirects >= policy.maxRedirects) {
          throw new A2ABridgeError('A2A_FETCH_REDIRECT_LIMIT', 'Remote A2A request exceeded the redirect limit.')
        }

        let target: URL
        try {
          target = validateUrl(new URL(location, currentUrl).href)
        } catch (error) {
          if (error instanceof A2ABridgeError) throw error
          throw new A2ABridgeError('A2A_FETCH_URL_REJECTED', 'Remote A2A redirect URL is invalid.', { cause: error })
        }
        if (currentUrl.protocol === 'https:' && target.protocol === 'http:') {
          throw new A2ABridgeError('A2A_FETCH_DOWNGRADE', 'Remote A2A redirect cannot downgrade HTTPS to HTTP.')
        }
        if (target.origin !== currentUrl.origin) {
          headers = new Headers(headers)
          headers.delete('authorization')
          headers.delete('cookie')
          headers.delete('proxy-authorization')
        }
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET'
          body = undefined
          headers = new Headers(headers)
          headers.delete('content-length')
          headers.delete('content-type')
        }
        currentUrl = target
        redirects += 1
      }
    } catch (error) {
      if (error instanceof A2ABridgeError) throw error
      if (timeoutSignal.aborted && !callerSignal.aborted) {
        throw new A2ABridgeError('A2A_FETCH_TIMEOUT', 'Remote A2A request timed out.', { cause: error })
      }
      if (callerSignal.aborted) {
        throw new A2ABridgeError('A2A_FETCH_ABORTED', 'Remote A2A request was canceled.', { cause: error })
      }
      throw new A2ABridgeError('A2A_FETCH_FAILED', 'Remote A2A request failed.', { cause: error })
    }
  }

  return boundedFetch as typeof fetch
}

async function streamingBoundedResponse(response: Response, maximum: number): Promise<Response> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maximum) {
      await cancelBody(response)
      throw new A2ABridgeError('A2A_FETCH_TOO_LARGE', 'Remote A2A response exceeds the configured byte limit.')
    }
  }
  if (response.body === null) return new Response(null, responseInit(response))

  let total = 0
  const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength
      if (total > maximum) {
        controller.error(new A2ABridgeError(
          'A2A_FETCH_TOO_LARGE',
          'Remote A2A response exceeds the configured byte limit.',
        ))
        return
      }
      controller.enqueue(chunk)
    },
  }))
  return new Response(bounded, responseInit(response))
}

function validateUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch (error) {
    throw new A2ABridgeError('A2A_FETCH_URL_REJECTED', 'Remote A2A URL must be absolute HTTP(S).', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new A2ABridgeError('A2A_FETCH_URL_REJECTED', 'Remote A2A URL must use HTTP or HTTPS.')
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new A2ABridgeError('A2A_FETCH_URL_REJECTED', 'Remote A2A URL must not contain credentials or a fragment.')
  }
  return url
}

async function boundedResponse(response: Response, maximum: number, signal: AbortSignal): Promise<Response> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maximum) {
      await cancelBody(response)
      throw new A2ABridgeError('A2A_FETCH_TOO_LARGE', 'Remote A2A response exceeds the configured byte limit.')
    }
  }
  if (response.body === null) return new Response(null, responseInit(response))

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximum) {
        throw new A2ABridgeError('A2A_FETCH_TOO_LARGE', 'Remote A2A response exceeds the configured byte limit.')
      }
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch((_cancelError: unknown) => {
      // The size or abort result already owns this operation; cancellation only releases the body.
    })
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Response(bytes.byteLength === 0 ? null : bytes, responseInit(response))
}

function responseInit(response: Response): ResponseInit {
  return { status: response.status, statusText: response.statusText, headers: response.headers }
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch((_cancelError: unknown) => {
    // Redirect and rejection paths already have their result; cancellation only releases the body.
  })
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`business-a2a-bridge: ${field} must be a positive integer`)
  }
}
