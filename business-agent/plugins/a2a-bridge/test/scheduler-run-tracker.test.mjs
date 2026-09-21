import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  A2AContextId,
  A2ATaskId,
  BoundedContextScheduler,
  EventSessionTurnTracker,
} from '../lib/index.js'

function deferred() {
  return Promise.withResolvers()
}

function emitSession(ctx, session, type, data) {
  ctx.emit('session/event', session, { type, data })
}

function emitStream(ctx, agent, frame) {
  ctx.emit('agent/assistant-stream', { agent, frame })
}

test('schedules FIFO per context while admitting configured cross-context concurrency', async () => {
  const scheduler = new BoundedContextScheduler(2)
  const releases = new Map()
  const starts = new Map()
  const order = []

  function operation(name) {
    const started = deferred()
    const release = deferred()
    starts.set(name, started)
    releases.set(name, release)
    return async () => {
      order.push(name)
      started.resolve()
      await release.promise
      return `${name}:done`
    }
  }

  const a1 = scheduler.run(A2ATaskId('a1'), A2AContextId('a'), operation('a1'))
  const a2 = scheduler.run(A2ATaskId('a2'), A2AContextId('a'), operation('a2'))
  const b1 = scheduler.run(A2ATaskId('b1'), A2AContextId('b'), operation('b1'))
  const c1 = scheduler.run(A2ATaskId('c1'), A2AContextId('c'), operation('c1'))

  await Promise.all([starts.get('a1').promise, starts.get('b1').promise])
  assert.deepEqual(order, ['a1', 'b1'])

  releases.get('b1').resolve()
  await starts.get('c1').promise
  assert.deepEqual(order, ['a1', 'b1', 'c1'])

  releases.get('a1').resolve()
  await starts.get('a2').promise
  assert.deepEqual(order, ['a1', 'b1', 'c1', 'a2'])

  releases.get('a2').resolve()
  releases.get('c1').resolve()
  assert.deepEqual(await Promise.all([a1, a2, b1, c1]), [
    'a1:done',
    'a2:done',
    'b1:done',
    'c1:done',
  ])
  await scheduler.close()
})

test('removes queued tasks and aborts only the selected active task', async () => {
  const scheduler = new BoundedContextScheduler(1)
  const activeStarted = deferred()
  const activeAborted = deferred()
  const activeRelease = deferred()
  let queuedStarted = false

  const active = scheduler.run(A2ATaskId('active'), A2AContextId('active-context'), async signal => {
    activeStarted.resolve()
    signal.addEventListener('abort', () => activeAborted.resolve(signal.reason), { once: true })
    await activeRelease.promise
    throw signal.reason
  })
  const activeRejection = assert.rejects(active, /A2A task active was canceled/)
  const queued = scheduler.run(A2ATaskId('queued'), A2AContextId('queued-context'), async () => {
    queuedStarted = true
  })
  const queuedRejection = assert.rejects(queued, /A2A task queued was canceled/)

  await activeStarted.promise
  assert.equal(scheduler.cancel(A2ATaskId('queued')), 'queued')
  await queuedRejection
  assert.equal(queuedStarted, false)

  assert.equal(scheduler.cancel(A2ATaskId('active')), 'active')
  assert.match((await activeAborted.promise).message, /A2A task active was canceled/)
  assert.equal(scheduler.cancel(A2ATaskId('unknown')), 'missing')
  activeRelease.resolve()
  await activeRejection
  await scheduler.close()
})

test('close rejects admission, cancels queued work, and waits for active settlement', async () => {
  const scheduler = new BoundedContextScheduler(1)
  const activeStarted = deferred()
  const activeAborted = deferred()
  const activeRelease = deferred()

  const active = scheduler.run(A2ATaskId('active-close'), A2AContextId('one'), async signal => {
    activeStarted.resolve()
    signal.addEventListener('abort', () => activeAborted.resolve(), { once: true })
    await activeRelease.promise
    return 'settled'
  })
  const queued = scheduler.run(A2ATaskId('queued-close'), A2AContextId('two'), async () => 'must-not-run')
  const queuedRejection = assert.rejects(queued, /scheduler closed/)

  await activeStarted.promise
  let closed = false
  const closing = scheduler.close().then(() => { closed = true })
  await activeAborted.promise
  await queuedRejection
  await Promise.resolve()
  assert.equal(closed, false)

  activeRelease.resolve()
  assert.equal(await active, 'settled')
  await closing
  assert.equal(closed, true)
  await assert.rejects(
    scheduler.run(A2ATaskId('late'), A2AContextId('one'), async () => undefined),
    /scheduler closed/,
  )
})

test('correlates interleaved requests to exact session turns and live attempts', async () => {
  const ctx = new Context()
  const tracker = new EventSessionTurnTracker(ctx)
  const sessionA = { id: 'session-a' }
  const sessionB = { id: 'session-b' }
  const agentA = { session: sessionA }
  const agentB = { session: sessionB }
  const deltasA = []
  const deltasB = []

  const trackedA = tracker.track({
    sessionId: sessionA.id,
    requestId: 'request-a',
    signal: new AbortController().signal,
    onTextDelta(delta) { deltasA.push(delta) },
  })
  const trackedB = tracker.track({
    sessionId: sessionB.id,
    requestId: 'request-b',
    signal: new AbortController().signal,
    onTextDelta(delta) { deltasB.push(delta) },
  })

  emitSession(ctx, sessionA, 'turn/start', { turn: 1 })
  emitSession(ctx, sessionA, 'user/message', {
    content: [{ type: 'text', text: 'A' }],
    source: { kind: 'user', rpcId: 'request-a' },
  })
  emitSession(ctx, sessionB, 'turn/start', { turn: 7 })
  emitSession(ctx, sessionB, 'user/message', {
    content: [{ type: 'text', text: 'B' }],
    source: { kind: 'user', rpcId: 'request-b' },
  })

  emitStream(ctx, agentA, { type: 'start', attemptId: 'attempt-a-old', revision: 1, turn: 1, step: 1 })
  emitStream(ctx, agentA, {
    type: 'chunk', attemptId: 'attempt-a-old', revision: 2, index: 0, time: 1,
    chunk: { type: 'text-delta', index: 0, text: 'discarded-retry' },
  })
  emitStream(ctx, agentA, { type: 'start', attemptId: 'attempt-a', revision: 3, turn: 1, step: 1 })
  emitStream(ctx, agentA, {
    type: 'chunk', attemptId: 'attempt-a-old', revision: 4, index: 1, time: 2,
    chunk: { type: 'text-delta', index: 0, text: 'stale' },
  })
  emitStream(ctx, agentB, { type: 'start', attemptId: 'attempt-b', revision: 1, turn: 7, step: 1 })
  emitStream(ctx, agentB, {
    type: 'chunk', attemptId: 'attempt-b', revision: 2, index: 0, time: 3,
    chunk: { type: 'reasoning-delta', index: 0, text: 'hidden' },
  })
  emitStream(ctx, agentB, {
    type: 'chunk', attemptId: 'attempt-b', revision: 3, index: 1, time: 4,
    chunk: { type: 'text-delta', index: 0, text: 'B-live' },
  })
  emitStream(ctx, agentA, {
    type: 'chunk', attemptId: 'attempt-a', revision: 5, index: 0, time: 5,
    chunk: { type: 'text-delta', index: 0, text: 'A-live' },
  })

  emitSession(ctx, sessionB, 'assistant/message', {
    turn: 7,
    step: 1,
    stream: [],
    message: { content: [{ type: 'text', text: 'B-final' }] },
  })
  emitSession(ctx, sessionB, 'turn/end', { turn: 7, reason: { kind: 'completed' } })
  emitSession(ctx, sessionA, 'assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: { content: [{ type: 'text', text: 'A-' }, { type: 'text', text: 'final' }] },
  })
  emitSession(ctx, sessionA, 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  assert.deepEqual(await trackedA, { turn: 1, text: 'A-final', reason: { kind: 'completed' } })
  assert.deepEqual(await trackedB, { turn: 7, text: 'B-final', reason: { kind: 'completed' } })
  assert.deepEqual(deltasA, ['discarded-retry', 'A-live'])
  assert.deepEqual(deltasB, ['B-live'])
  await tracker.close()
})

test('aborts and closes tracked requests without leaking callbacks', async () => {
  const ctx = new Context()
  const tracker = new EventSessionTurnTracker(ctx)
  const session = { id: 'session-cleanup' }
  const agent = { session }
  const controller = new AbortController()
  const deltas = []
  const aborted = tracker.track({
    sessionId: session.id,
    requestId: 'request-aborted',
    signal: controller.signal,
    onTextDelta(delta) { deltas.push(delta) },
  })

  controller.abort(new Error('caller canceled'))
  await assert.rejects(aborted, /caller canceled/)
  emitSession(ctx, session, 'turn/start', { turn: 1 })
  emitSession(ctx, session, 'user/message', { source: { kind: 'user', rpcId: 'request-aborted' } })
  emitStream(ctx, agent, { type: 'start', attemptId: 'late', revision: 1, turn: 1, step: 1 })
  emitStream(ctx, agent, {
    type: 'chunk', attemptId: 'late', revision: 2, index: 0, time: 1,
    chunk: { type: 'text-delta', index: 0, text: 'late' },
  })
  assert.deepEqual(deltas, [])

  const pending = tracker.track({
    sessionId: session.id,
    requestId: 'request-close',
    signal: new AbortController().signal,
    onTextDelta() {},
  })
  const pendingRejection = assert.rejects(pending, /turn tracker closed/)
  await tracker.close()
  await pendingRejection
  await assert.rejects(tracker.track({
    sessionId: session.id,
    requestId: 'request-late',
    signal: new AbortController().signal,
    onTextDelta() {},
  }), /turn tracker closed/)
})
