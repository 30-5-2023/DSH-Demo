import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  A2AFilePublications,
  A2AFileTransfer,
  A2ATaskId,
  createPublishA2AFileTool,
} from '../lib/index.js'

function stored(name, bytes, suffix = name) {
  return {
    name,
    ref: { attachmentId: `sha256:${suffix}`, name, bytes },
    mediaType: 'application/octet-stream',
  }
}

function exec(sessionId, cwd = 'C:\\workspace') {
  return {
    agent: { session: { header: { id: sessionId, cwd } } },
    signal: new AbortController().signal,
  }
}

test('isolates ordered publication windows by Session and closes them deterministically', () => {
  const publications = new A2AFilePublications()
  const first = publications.open(A2ATaskId('task-first'), SessionId('session-first'))
  const second = publications.open(A2ATaskId('task-second'), SessionId('session-second'))
  const firstA = stored('first-a.bin', 1)
  const firstB = stored('first-b.bin', 2)
  const secondA = stored('second-a.bin', 3)

  publications.publish(SessionId('session-first'), firstA)
  publications.publish(SessionId('session-second'), secondA)
  publications.publish(SessionId('session-first'), firstB)
  assert.deepEqual(first.files(), [firstA, firstB])
  assert.deepEqual(second.files(), [secondA])
  assert.throws(
    () => publications.open(A2ATaskId('task-duplicate'), SessionId('session-first')),
    /active publication window/i,
  )

  first[Symbol.dispose]()
  assert.throws(() => publications.publish(SessionId('session-first'), firstA), /active publication window/i)
  assert.deepEqual(first.files(), [firstA, firstB])
  second[Symbol.dispose]()
})

test('publish tool requires an Agent and active window, snapshots from Session cwd, and returns metadata only', async () => {
  const publications = new A2AFilePublications()
  const calls = []
  const transfer = {
    async snapshotLocal(input, cwd, signal) {
      calls.push({ input, cwd, signal })
      return {
        ref: { attachmentId: 'sha256:published', name: 'safe.txt', bytes: 7 },
        mediaType: 'text/plain',
      }
    },
  }
  const tool = createPublishA2AFileTool(publications, transfer)
  const args = { path: 'generated/unsafe.txt', name: '../safe.txt', mime_type: 'text/plain' }
  const signal = new AbortController().signal

  await assert.rejects(tool.execute(args, { signal }), /Agent-backed Session/i)
  await assert.rejects(tool.execute(args, exec(SessionId('session-publish'))), /active publication window/i)
  assert.equal(calls.length, 0)

  const window = publications.open(A2ATaskId('task-publish'), SessionId('session-publish'))
  const value = await tool.execute(args, exec(SessionId('session-publish')))
  assert.deepEqual(value, {
    name: 'safe.txt',
    mime_type: 'text/plain',
    bytes: 7,
    attachment_id: 'sha256:published',
  })
  assert.deepEqual(Object.keys(value).sort(), ['attachment_id', 'bytes', 'mime_type', 'name'])
  assert.doesNotMatch(JSON.stringify(value), /generated|unsafe|token|data/i)
  assert.deepEqual(calls.map(call => ({ input: call.input, cwd: call.cwd, aborted: call.signal.aborted })), [{
    input: args,
    cwd: 'C:\\workspace',
    aborted: false,
  }])
  assert.deepEqual(window.files(), [{
    name: 'safe.txt',
    ref: { attachmentId: 'sha256:published', name: 'safe.txt', bytes: 7 },
    mediaType: 'text/plain',
  }])
  assert.equal(tool.presentCall(args).rawInput, 'safe.txt')

  window[Symbol.dispose]()
  await assert.rejects(tool.execute(args, exec(SessionId('session-publish'))), /active publication window/i)
  assert.equal(calls.length, 1)
})

test('converts the inline threshold to raw bytes and one byte above it to a hosted URL', async () => {
  const payloads = new Map([
    ['sha256:small', Buffer.from('1234')],
    ['sha256:large', Buffer.from('12345')],
  ])
  const issued = []
  const transfer = new A2AFileTransfer({
    attachments: {
      async *readFileStream(ref) { yield payloads.get(ref.attachmentId) },
      saveFileStream: async () => { throw new Error('unexpected save') },
      fileHostPath: () => undefined,
    },
    fileUploads: { uploadStream: async () => { throw new Error('unexpected upload') } },
    maxFileBytes: 10,
    inlineFileMaxBytes: 4,
    fetchTimeoutMs: 1_000,
    maxRedirects: 1,
    publishFileAllowedRoots: [],
    fileLinks: {
      async issue(file, taskId) {
        issued.push({ file, taskId })
        return new URL(`http://agent.internal/a2a/files/${file.ref.name}`)
      },
    },
  })
  const taskId = A2ATaskId('task-threshold')
  const small = stored('small.bin', 4, 'small')
  const large = stored('large.bin', 5, 'large')

  const inline = await transfer.toPart(small, taskId)
  const hosted = await transfer.toPart(large, taskId)
  assert.equal(inline.content.$case, 'raw')
  assert.equal(Buffer.from(inline.content.value).toString(), '1234')
  assert.equal(inline.filename, 'small.bin')
  assert.equal(hosted.content.$case, 'url')
  assert.equal(hosted.content.value, 'http://agent.internal/a2a/files/large.bin')
  assert.equal(hosted.filename, 'large.bin')
  assert.deepEqual(issued, [{ file: large, taskId }])
})
