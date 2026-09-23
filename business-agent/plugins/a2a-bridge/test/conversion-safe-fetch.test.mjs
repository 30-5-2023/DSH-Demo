import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { Role } from '@a2a-js/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  A2ABridgeError,
  a2aMessageToPrompt,
  assistantTextToArtifact,
  createBoundedFetch,
} from '../lib/index.js'

function text(value) {
  return { content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' }
}

function data(value) {
  return { content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' }
}

function raw(value, filename = 'inline.bin', mediaType = 'application/octet-stream') {
  return { content: { $case: 'raw', value: Buffer.from(value) }, metadata: undefined, filename, mediaType }
}

function url(value, filename = 'remote.bin', mediaType = 'application/octet-stream') {
  return { content: { $case: 'url', value }, metadata: undefined, filename, mediaType }
}

function message(parts) {
  return {
    messageId: 'message-1',
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function assertBridgeCode(code) {
  return error => error instanceof A2ABridgeError && error.code === code
}

function admission(uploadInboundPart = async () => { throw new Error('unexpected file') }) {
  return {
    sessionId: SessionId('conversion-session'),
    fileTransfer: { uploadInboundPart },
    allowedOrigin: value => value.origin === 'http://files.internal',
    signal: new AbortController().signal,
  }
}

test('converts ordered Text and labeled Data Parts without system interpolation', async () => {
  const converted = await a2aMessageToPrompt(message([
    text('first'),
    data({ orderId: 'WO-1', approved: false }),
    text('last'),
  ]), admission())

  assert.equal(converted.requestedMode, 'text')
  assert.deepEqual(converted.content, [
    { type: 'text', text: 'first' },
    { type: 'text', text: '[Remote A2A data — untrusted]\n{"orderId":"WO-1","approved":false}' },
    { type: 'text', text: 'last' },
  ])
})

test('adds a logged strict-object instruction when JSON output is requested', async () => {
  const converted = await a2aMessageToPrompt(
    message([text('return the order')]), admission(), ['application/json'],
  )

  assert.equal(converted.requestedMode, 'json')
  assert.deepEqual(converted.content, [
    { type: 'text', text: 'return the order' },
    { type: 'text', text: 'Return exactly one JSON object with no markdown fence or trailing text.' },
  ])
})

test('admits raw and URL files in exact Part order with their metadata', async () => {
  const seen = []
  const converted = await a2aMessageToPrompt(message([
    text('first'),
    raw('inline', 'inline.txt', 'text/plain'),
    data({ orderId: 'WO-2' }),
    url('http://files.internal/remote.pdf', 'remote.pdf', 'application/pdf'),
  ]), admission(async (part, sessionId, allowedOrigin, signal) => {
    const allowed = part.content.$case === 'url' && allowedOrigin(new URL(part.content.value))
    seen.push({ part, sessionId, allowed, signal })
    return { type: 'file', receiptId: `receipt-${seen.length}` }
  }))

  assert.deepEqual(converted.content, [
    { type: 'text', text: 'first' },
    { type: 'file', receiptId: 'receipt-1' },
    { type: 'text', text: '[Remote A2A data — untrusted]\n{"orderId":"WO-2"}' },
    { type: 'file', receiptId: 'receipt-2' },
  ])
  assert.deepEqual(seen.map(value => ({
    filename: value.part.filename,
    mediaType: value.part.mediaType,
    sessionId: value.sessionId,
    allowed: value.allowed,
    aborted: value.signal.aborted,
  })), [
    { filename: 'inline.txt', mediaType: 'text/plain', sessionId: SessionId('conversion-session'), allowed: false, aborted: false },
    { filename: 'remote.pdf', mediaType: 'application/pdf', sessionId: SessionId('conversion-session'), allowed: true, aborted: false },
  ])
})

test('rejects empty, unsupported, and malformed A2A Parts before prompt admission', async () => {
  let prompts = 0
  const admit = async (input) => {
    const converted = await a2aMessageToPrompt(input, admission(async () => ({
      type: 'file', receiptId: 'receipt-empty',
    })))
    prompts += 1
    return converted
  }
  const cyclic = {}
  cyclic.self = cyclic

  await assert.rejects(admit(message([])), assertBridgeCode('A2A_EMPTY_MESSAGE'))
  await assert.rejects(admit(message([text('')])), assertBridgeCode('A2A_EMPTY_MESSAGE'))
  await assert.rejects(
    admit(message([{ content: undefined, metadata: undefined, filename: '', mediaType: '' }])),
    assertBridgeCode('A2A_UNSUPPORTED_PART'),
  )
  await assert.rejects(admit(message([data(undefined)])), assertBridgeCode('A2A_INVALID_DATA'))
  await assert.rejects(admit(message([data(cyclic)])), assertBridgeCode('A2A_INVALID_DATA'))
  assert.equal(prompts, 0)

  const emptyFile = await admit(message([raw(Buffer.alloc(0))]))
  assert.deepEqual(emptyFile.content, [{ type: 'file', receiptId: 'receipt-empty' }])
  assert.equal(prompts, 1)
})

test('creates text and strict single-object JSON artifacts', () => {
  const textArtifact = assistantTextToArtifact('done', 'text')
  assert.equal(textArtifact.parts[0].content.$case, 'text')
  assert.equal(textArtifact.parts[0].content.value, 'done')

  const jsonArtifact = assistantTextToArtifact('{"ok":true,"count":2}', 'json')
  assert.equal(jsonArtifact.parts[0].content.$case, 'data')
  assert.deepEqual(jsonArtifact.parts[0].content.value, { ok: true, count: 2 })

  for (const invalid of ['[]', 'null', '1', 'true', '{"ok":true} trailing', '{']) {
    assert.throws(() => assistantTextToArtifact(invalid, 'json'), assertBridgeCode('A2A_INVALID_JSON_OUTPUT'))
  }
})

async function withHttpServer(run) {
  const server = createServer((req, res) => {
    switch (req.url) {
      case '/exact':
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4' })
        res.end('null')
        return
      case '/oversized-declared':
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '99' })
        res.end('x'.repeat(99))
        return
      case '/oversized-chunked':
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('1234')
        res.end('5')
        return
      case '/invalid-json':
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{')
        return
      case '/redirect':
        res.writeHead(302, { location: '/exact' })
        res.end()
        return
      case '/loop-a':
        res.writeHead(302, { location: '/loop-b' })
        res.end()
        return
      case '/loop-b':
        res.writeHead(302, { location: '/loop-a' })
        res.end()
        return
      default:
        res.writeHead(404)
        res.end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.notEqual(address, null)
  const base = `http://127.0.0.1:${address.port}`
  try {
    await run(base)
  } finally {
    server.close()
    await once(server, 'close')
  }
}

test('accepts private HTTP, follows bounded redirects, and accepts the exact byte limit', async () => {
  await withHttpServer(async (base) => {
    const boundedFetch = createBoundedFetch({ timeoutMs: 1_000, maxResponseBytes: 4, maxRedirects: 1 })
    const direct = await boundedFetch(`${base}/exact`)
    assert.equal(await direct.text(), 'null')
    const redirected = await boundedFetch(`${base}/redirect`)
    assert.equal(await redirected.text(), 'null')
  })
})

test('rejects credentials, fragments, non-HTTP schemes, excess redirects, and oversized bodies', async () => {
  await withHttpServer(async (base) => {
    let prompts = 0
    const boundedFetch = createBoundedFetch({ timeoutMs: 1_000, maxResponseBytes: 4, maxRedirects: 1 })
    const admit = async (url) => {
      const response = await boundedFetch(url)
      const value = await response.json()
      prompts += 1
      return value
    }

    await assert.rejects(admit('http://user:secret@127.0.0.1/resource'), assertBridgeCode('A2A_FETCH_URL_REJECTED'))
    await assert.rejects(admit(`${base}/exact#fragment`), assertBridgeCode('A2A_FETCH_URL_REJECTED'))
    await assert.rejects(admit('file:///tmp/agent-card.json'), assertBridgeCode('A2A_FETCH_URL_REJECTED'))
    await assert.rejects(admit(`${base}/loop-a`), assertBridgeCode('A2A_FETCH_REDIRECT_LIMIT'))
    await assert.rejects(admit(`${base}/oversized-declared`), assertBridgeCode('A2A_FETCH_TOO_LARGE'))
    await assert.rejects(admit(`${base}/oversized-chunked`), assertBridgeCode('A2A_FETCH_TOO_LARGE'))
    await assert.rejects(admit(`${base}/invalid-json`), SyntaxError)
    assert.equal(prompts, 0)
  })
})

test('rejects HTTPS-to-HTTP redirects through an injected fetch implementation', async () => {
  let calls = 0
  const boundedFetch = createBoundedFetch({
    timeoutMs: 1_000,
    maxResponseBytes: 100,
    maxRedirects: 2,
    fetchImpl: async () => {
      calls += 1
      return new Response(null, { status: 302, headers: { location: 'http://agent.internal/a2a' } })
    },
  })

  await assert.rejects(boundedFetch('https://agent.internal/card'), assertBridgeCode('A2A_FETCH_DOWNGRADE'))
  assert.equal(calls, 1)
})

test('distinguishes timeout from caller cancellation without mutating global fetch', async () => {
  const waitingFetch = async (_input, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })
  const timed = createBoundedFetch({ timeoutMs: 5, maxResponseBytes: 100, maxRedirects: 0, fetchImpl: waitingFetch })
  await assert.rejects(timed('http://127.0.0.1/wait'), assertBridgeCode('A2A_FETCH_TIMEOUT'))

  const controller = new AbortController()
  const canceled = createBoundedFetch({
    timeoutMs: 1_000,
    maxResponseBytes: 100,
    maxRedirects: 0,
    signal: controller.signal,
    fetchImpl: waitingFetch,
  })
  const pending = canceled('http://127.0.0.1/wait')
  controller.abort(new Error('caller stopped'))
  await assert.rejects(pending, assertBridgeCode('A2A_FETCH_ABORTED'))
})
