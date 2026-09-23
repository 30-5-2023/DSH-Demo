import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FileUploads } from '@deepseek-ai/dsh-client-file-upload'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  A2ABridgeError,
  A2AFileTransfer,
  boundedBytes,
  mediaTypeOrDefault,
  safeFileName,
} from '../lib/index.js'

function assertBridgeCode(code) {
  return error => error instanceof A2ABridgeError && error.code === code
}

function rawPart(bytes, filename = 'payload.bin', mediaType = 'application/octet-stream') {
  return {
    content: { $case: 'raw', value: Buffer.from(bytes) },
    metadata: undefined,
    filename,
    mediaType,
  }
}

function urlPart(url, filename = 'payload.bin', mediaType = 'application/octet-stream') {
  return {
    content: { $case: 'url', value: url },
    metadata: undefined,
    filename,
    mediaType,
  }
}

async function collect(source) {
  const chunks = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function memoryDependencies(root, hooks = {}) {
  const saved = []
  const uploaded = []
  let next = 0
  const save = async (input, target) => {
    const chunks = []
    for await (const chunk of input.data) {
      chunks.push(Buffer.from(chunk))
      await hooks.afterChunk?.(chunks.length)
    }
    const data = Buffer.concat(chunks)
    const name = input.name ?? 'file'
    const ref = { attachmentId: `sha256:test-${next++}`, name, bytes: data.byteLength }
    target.push({ data, ref })
    return ref
  }
  return {
    saved,
    uploaded,
    attachments: {
      saveFileStream: input => save(input, saved),
      async *readFileStream() { throw new Error('unexpected file read') },
      fileHostPath: ref => join(root, 'objects', ref.name),
    },
    fileUploads: {
      uploadStream: async input => ({
        receiptId: `receipt-${uploaded.length}`,
        file: await save(input, uploaded),
      }),
    },
  }
}

function transfer(dependencies, overrides = {}) {
  return new A2AFileTransfer({
    ...dependencies,
    maxFileBytes: 16,
    inlineFileMaxBytes: 1,
    fetchTimeoutMs: 1_000,
    maxRedirects: 1,
    publishFileAllowedRoots: [],
    fileLinks: { issue: async () => { throw new Error('unexpected file link') } },
    ...overrides,
  })
}

test('normalizes safe leaf names and validates media types', () => {
  assert.equal(safeFileName('../reports/order.txt'), 'order.txt')
  assert.equal(safeFileName('C:\\reports\\order.txt'), 'order.txt')
  assert.equal(mediaTypeOrDefault(undefined), 'application/octet-stream')
  assert.equal(mediaTypeOrDefault(''), 'application/octet-stream')
  assert.equal(mediaTypeOrDefault('application/pdf'), 'application/pdf')
  assert.throws(() => safeFileName('  '), assertBridgeCode('A2A_FILE_NAME_INVALID'))
  assert.throws(() => safeFileName('bad\0name.txt'), assertBridgeCode('A2A_FILE_NAME_INVALID'))
  assert.throws(() => mediaTypeOrDefault('text/plain\r\nx-test: yes'), assertBridgeCode('A2A_MEDIA_TYPE_INVALID'))
  assert.throws(() => mediaTypeOrDefault('not-a-media-type'), assertBridgeCode('A2A_MEDIA_TYPE_INVALID'))
})

test('bounds measured chunks and releases canceled sources', async () => {
  let released = false
  async function *oversized() {
    try {
      yield Buffer.from('1234')
      yield Buffer.from('56')
    } finally {
      released = true
    }
  }
  await assert.rejects(collect(boundedBytes(oversized(), 5)), assertBridgeCode('A2A_FILE_TOO_LARGE'))
  assert.equal(released, true)

  const controller = new AbortController()
  controller.abort(new Error('caller stopped'))
  await assert.rejects(collect(boundedBytes(oversized(), 8, controller.signal)), assertBridgeCode('A2A_FILE_FETCH_ABORTED'))
})

test('enforces URL origin, redirect, downgrade, and measured-byte policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-transfer-http-'))
  const dependencies = memoryDependencies(root)
  let calls = 0
  let redirectCanceled = false
  const fetchImpl = async (input) => {
    calls += 1
    const url = new URL(input)
    if (url.pathname === '/redirect-unlisted') {
      return new Response(new ReadableStream({
        cancel() { redirectCanceled = true },
      }), { status: 302, headers: { location: 'http://other.internal/file' } })
    }
    if (url.pathname === '/loop') {
      return new Response(null, { status: 302, headers: { location: '/loop' } })
    }
    if (url.pathname === '/downgrade') {
      return new Response(null, { status: 302, headers: { location: 'http://files.internal/file' } })
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('1234'))
        controller.enqueue(Buffer.from('56'))
        controller.close()
      },
    }), { status: 200, headers: { 'content-length': '4' } })
  }
  const service = transfer(dependencies, { maxFileBytes: 5, fetchImpl })
  const allowed = url => url.origin === 'http://files.internal' || url.origin === 'https://files.internal'
  try {
    await assert.rejects(
      service.materializePart(urlPart('http://user:secret@files.internal/file'), allowed, AbortSignal.timeout(1_000)),
      assertBridgeCode('A2A_FILE_URI_REJECTED'),
    )
    await assert.rejects(
      service.materializePart(urlPart('http://files.internal/file#fragment'), allowed, AbortSignal.timeout(1_000)),
      assertBridgeCode('A2A_FILE_URI_REJECTED'),
    )
    await assert.rejects(
      service.materializePart(urlPart('http://blocked.internal/file'), allowed, AbortSignal.timeout(1_000)),
      assertBridgeCode('A2A_FILE_URI_REJECTED'),
    )
    assert.equal(calls, 0)
    await assert.rejects(
      service.materializePart(urlPart('http://files.internal/redirect-unlisted'), allowed, AbortSignal.timeout(1_000)),
      assertBridgeCode('A2A_FILE_URI_REJECTED'),
    )
    assert.equal(redirectCanceled, true)
    await assert.rejects(
      service.materializePart(urlPart('http://files.internal/loop'), allowed, AbortSignal.timeout(1_000)),
      assertBridgeCode('A2A_FILE_REDIRECT_LIMIT'),
    )
    await assert.rejects(
      service.materializePart(urlPart('https://files.internal/downgrade'), allowed, AbortSignal.timeout(1_000)),
      assertBridgeCode('A2A_FILE_DOWNGRADE'),
    )
    await assert.rejects(
      service.materializePart(urlPart('http://files.internal/lying-length'), allowed, AbortSignal.timeout(1_000)),
      assertBridgeCode('A2A_FILE_TOO_LARGE'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('distinguishes file-fetch timeout from caller cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-transfer-cancel-'))
  const dependencies = memoryDependencies(root)
  const waitingFetch = async (_input, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })
  const allowed = url => url.origin === 'http://files.internal'
  try {
    const timed = transfer(dependencies, { fetchTimeoutMs: 5, fetchImpl: waitingFetch })
    await assert.rejects(
      timed.materializePart(urlPart('http://files.internal/wait'), allowed, new AbortController().signal),
      assertBridgeCode('A2A_FILE_FETCH_TIMEOUT'),
    )

    const controller = new AbortController()
    const canceled = transfer(dependencies, { fetchImpl: waitingFetch })
    const pending = canceled.materializePart(urlPart('http://files.internal/wait'), allowed, controller.signal)
    controller.abort(new Error('caller stopped'))
    await assert.rejects(pending, assertBridgeCode('A2A_FILE_FETCH_ABORTED'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('times out and releases a stalled response body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-transfer-body-timeout-'))
  const dependencies = memoryDependencies(root)
  let canceled = false
  const fetchImpl = async () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}) },
    cancel() { canceled = true },
  }))
  const service = transfer(dependencies, { fetchTimeoutMs: 5, fetchImpl })
  try {
    await assert.rejects(
      service.materializePart(
        urlPart('http://files.internal/stalled'),
        url => url.origin === 'http://files.internal',
        new AbortController().signal,
      ),
      assertBridgeCode('A2A_FILE_FETCH_TIMEOUT'),
    )
    assert.equal(canceled, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('snapshots only stable regular files inside resolved allowed roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-transfer-local-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await mkdir(workspace)
  await mkdir(outside)
  await mkdir(join(workspace, 'inside-target'))
  await writeFile(join(workspace, 'inside.txt'), 'inside')
  await writeFile(join(workspace, 'inside-target', 'linked.txt'), 'linked-inside')
  await writeFile(join(outside, 'outside.txt'), 'outside')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(workspace, 'inside-target'), join(workspace, 'inside-link'), linkType)
  await symlink(outside, join(workspace, 'outside-link'), linkType)
  const dependencies = memoryDependencies(root)
  const service = transfer(dependencies)
  try {
    const stored = await service.snapshotLocal(
      { path: 'inside.txt', mime_type: 'text/plain' }, workspace, AbortSignal.timeout(1_000),
    )
    assert.equal(stored.mediaType, 'text/plain')
    assert.equal(dependencies.saved[0].data.toString(), 'inside')
    assert.equal(stored.ref.name, 'inside.txt')

    const linked = await service.snapshotLocal(
      { path: 'inside-link/linked.txt' }, workspace, AbortSignal.timeout(1_000),
    )
    assert.equal(linked.ref.name, 'linked.txt')
    await assert.rejects(
      service.snapshotLocal({ path: '../outside/outside.txt' }, workspace, AbortSignal.timeout(1_000)),
      assertBridgeCode('A2A_FILE_PATH_REJECTED'),
    )
    await assert.rejects(
      service.snapshotLocal({ path: 'outside-link/outside.txt' }, workspace, AbortSignal.timeout(1_000)),
      assertBridgeCode('A2A_FILE_PATH_REJECTED'),
    )

    const rootAllowed = transfer(dependencies, { publishFileAllowedRoots: [await realpath(outside)] })
    const allowed = await rootAllowed.snapshotLocal(
      { path: join(outside, 'outside.txt') }, workspace, AbortSignal.timeout(1_000),
    )
    assert.equal(allowed.ref.name, 'outside.txt')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a local file mutated while its snapshot is streaming', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-transfer-mutate-'))
  const path = join(root, 'mutable.bin')
  await writeFile(path, Buffer.alloc(128 * 1_024, 1))
  let mutated = false
  const dependencies = memoryDependencies(root, {
    async afterChunk(count) {
      if (count !== 1 || mutated) return
      mutated = true
      await writeFile(path, Buffer.alloc(129 * 1_024, 2))
    },
  })
  const service = transfer(dependencies, { maxFileBytes: 256 * 1_024 })
  try {
    await assert.rejects(
      service.snapshotLocal({ path: 'mutable.bin' }, root, AbortSignal.timeout(2_000)),
      assertBridgeCode('A2A_FILE_UNSTABLE'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('uploads raw Parts into a Session and materializes stored outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-transfer-project-'))
  const dependencies = memoryDependencies(root)
  await mkdir(join(root, 'objects'), { recursive: true })
  const service = transfer(dependencies)
  try {
    const prompt = await service.uploadInboundPart(
      rawPart('hello', '../hello.txt', 'text/plain'),
      SessionId('file-session'),
      () => false,
      AbortSignal.timeout(1_000),
    )
    assert.deepEqual(prompt, { type: 'file', receiptId: 'receipt-0' })
    assert.equal(dependencies.uploaded[0].data.toString(), 'hello')
    assert.equal(dependencies.uploaded[0].ref.name, 'hello.txt')

    const output = await service.materializePart(
      rawPart('result', 'result.txt', 'text/plain'),
      () => false,
      AbortSignal.timeout(1_000),
    )
    assert.equal(output.mediaType, 'text/plain')
    assert.equal(output.path, join(root, 'objects', 'result.txt'))
    assert.equal(dependencies.saved.at(-1).data.toString(), 'result')

    const missingPath = transfer({
      ...dependencies,
      attachments: { ...dependencies.attachments, fileHostPath: () => undefined },
    })
    await assert.rejects(
      missingPath.materializePart(rawPart('x'), () => false, AbortSignal.timeout(1_000)),
      assertBridgeCode('A2A_ATTACHMENT_PATH_UNAVAILABLE'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('preserves bounded-transfer failures through the production FileUploads adapter', async () => {
  const sessionId = SessionId('production-upload-session')
  const session = { header: { id: sessionId, origin: 'user' } }
  const agent = { id: sessionId, session }
  const fileUploads = Object.create(FileUploads.prototype)
  fileUploads.stagedFiles = new WeakMap()
  fileUploads.agentResolver = undefined
  fileUploads.resolveAgent = async () => agent
  fileUploads.assertOrdinaryAgent = () => {}
  fileUploads.ctx = {
    agents: { get: () => agent },
    attachments: {
      isAttachmentError: () => false,
      async saveFileStream(input) {
        await collect(input.data)
        return { attachmentId: 'sha256:production-upload', name: input.name ?? 'file', bytes: 2 }
      },
    },
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-transfer-production-upload-'))
  const dependencies = memoryDependencies(root)
  const service = transfer({ ...dependencies, fileUploads }, { maxFileBytes: 1 })
  try {
    await assert.rejects(
      service.uploadInboundPart(rawPart('12'), sessionId, () => false, AbortSignal.timeout(1_000)),
      assertBridgeCode('A2A_FILE_TOO_LARGE'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
