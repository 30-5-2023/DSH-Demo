import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Role, TaskState } from '@a2a-js/sdk'
import { UnsupportedOperationError } from '@a2a-js/sdk/errors'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  A2AContextId,
  A2AMessageId,
  A2ATaskId,
  DomainTaskStore,
  StorageDomainA2ARepository,
} from '../lib/index.js'

function makeTask(id, contextId, state, options = {}) {
  return {
    id,
    contextId,
    status: {
      state,
      message: options.failure === undefined ? undefined : {
        messageId: `${id}-status`,
        contextId,
        taskId: id,
        role: Role.ROLE_AGENT,
        parts: [{ content: { $case: 'text', value: options.failure }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      timestamp: options.timestamp ?? '2026-09-20T00:00:00.000Z',
    },
    artifacts: options.artifact === undefined ? [] : [{
      artifactId: `${id}-artifact`,
      name: 'result',
      description: '',
      parts: [{ content: { $case: 'text', value: options.artifact }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
      metadata: undefined,
      extensions: [],
    }],
    history: [],
    metadata: undefined,
  }
}

async function openRepository(root) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  const repository = await StorageDomainA2ARepository.open(facility)
  return {
    repository,
    close: async () => {
      await repository.close()
      await backend.close()
      await ctx.fiber.dispose()
    },
  }
}

async function withRepository(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-store-'))
  const harness = await openRepository(root)
  try {
    await run(harness.repository)
  } finally {
    await harness.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('creates each context once and returns unknown lookups as undefined', async () => {
  await withRepository(async (repository) => {
    const contextId = A2AContextId('context-1')
    const record = {
      contextId,
      sessionId: SessionId('session-1'),
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    }

    assert.equal(await repository.getContext(A2AContextId('missing')), undefined)
    await repository.createContext(record)
    assert.deepEqual(await repository.getContext(contextId), record)
    await assert.rejects(repository.createContext(record), /already exists/i)
  })
})

test('round-trips tasks, scans by message id, and retains final artifacts', async () => {
  await withRepository(async (repository) => {
    const taskId = A2ATaskId('task-1')
    const messageId = A2AMessageId('message-1')
    const completed = makeTask(taskId, A2AContextId('context-1'), TaskState.TASK_STATE_COMPLETED, { artifact: 'done' })

    assert.equal(await repository.getTask(taskId), undefined)
    assert.equal(await repository.getTaskByMessageId(messageId), undefined)
    await repository.saveTask(completed, messageId)

    assert.deepEqual(await repository.getTask(taskId), completed)
    assert.deepEqual(await repository.getTaskByMessageId(messageId), completed)
    assert.equal((await repository.getTask(taskId)).artifacts[0].parts[0].content.value, 'done')
  })
})

test('allows forward state transitions and rejects terminal or backward rewrites', async () => {
  await withRepository(async (repository) => {
    const taskId = A2ATaskId('task-2')
    const contextId = A2AContextId('context-2')
    const messageId = A2AMessageId('message-2')
    const submitted = makeTask(taskId, contextId, TaskState.TASK_STATE_SUBMITTED)
    const working = makeTask(taskId, contextId, TaskState.TASK_STATE_WORKING)
    const completed = makeTask(taskId, contextId, TaskState.TASK_STATE_COMPLETED, { artifact: 'final' })

    await repository.saveTask(submitted, messageId)
    await repository.saveTask(working, messageId)
    await assert.rejects(repository.saveTask(submitted, messageId), /transition/i)
    await repository.saveTask(completed, messageId)
    await repository.saveTask(completed, messageId)
    await assert.rejects(
      repository.saveTask(makeTask(taskId, contextId, TaskState.TASK_STATE_FAILED), messageId),
      /terminal/i,
    )
    await assert.rejects(repository.saveTask(working, messageId), /terminal/i)
    assert.deepEqual(await repository.getTask(taskId), completed)
  })
})

test('adapts the SDK TaskStore and rejects task listing', async () => {
  await withRepository(async (repository) => {
    const store = new DomainTaskStore(repository)
    const task = makeTask(A2ATaskId('task-3'), A2AContextId('context-3'), TaskState.TASK_STATE_SUBMITTED)
    const context = { tenant: '', user: { isAuthenticated: false } }

    await store.save(task, context)
    assert.deepEqual(await store.load(task.id, context), task)
    await assert.rejects(
      store.list({ tenant: '', contextId: '', status: TaskState.TASK_STATE_UNSPECIFIED, pageToken: '', statusTimestampAfter: undefined }, context),
      error => error instanceof UnsupportedOperationError,
    )
  })
})

test('fails interrupted tasks on reopen while preserving final tasks and context sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a2a-restart-'))
  const now = '2026-09-21T00:00:00.000Z'
  try {
    {
      const harness = await openRepository(root)
      const contextId = A2AContextId('context-restart')
      await harness.repository.createContext({
        contextId,
        sessionId: SessionId('session-restart'),
        createdAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-09-20T00:00:00.000Z',
      })
      await harness.repository.saveTask(makeTask(A2ATaskId('task-submitted'), contextId, TaskState.TASK_STATE_SUBMITTED))
      await harness.repository.saveTask(makeTask(A2ATaskId('task-working'), contextId, TaskState.TASK_STATE_WORKING))
      await harness.repository.saveTask(makeTask(A2ATaskId('task-complete'), contextId, TaskState.TASK_STATE_COMPLETED, { artifact: 'kept' }))
      await harness.close()
    }

    const harness = await openRepository(root)
    try {
      assert.equal(await harness.repository.markInterruptedTasksFailed(now), 2)
      const submitted = await harness.repository.getTask(A2ATaskId('task-submitted'))
      const working = await harness.repository.getTask(A2ATaskId('task-working'))
      const completed = await harness.repository.getTask(A2ATaskId('task-complete'))
      const context = await harness.repository.getContext(A2AContextId('context-restart'))

      assert.equal(submitted.status.state, TaskState.TASK_STATE_FAILED)
      assert.match(submitted.status.message.parts[0].content.value, /A2A_HOST_INTERRUPTED/)
      assert.equal(working.status.state, TaskState.TASK_STATE_FAILED)
      assert.equal(completed.status.state, TaskState.TASK_STATE_COMPLETED)
      assert.equal(completed.artifacts[0].parts[0].content.value, 'kept')
      assert.equal(context.sessionId, SessionId('session-restart'))
      assert.equal(await harness.repository.markInterruptedTasksFailed(now), 0)
    } finally {
      await harness.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
