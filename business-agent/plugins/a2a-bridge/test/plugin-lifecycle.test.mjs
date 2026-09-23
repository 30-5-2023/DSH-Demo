import assert from 'node:assert/strict'
import test from 'node:test'
import { Role } from '@a2a-js/sdk'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import * as Bridge from '../lib/index.js'

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

function storageFixture(options = {}) {
  const state = { taskClosed: false, linksClosed: false, closedBeforePublication: false }
  return {
    state,
    facility: {
      async open(spec) {
        const taskDomain = spec.name === 'a2a_bridge'
        return {
          table() {
            return {
              entries() {
                if (taskDomain && options.taskEntriesError) throw options.taskEntriesError
                return [][Symbol.iterator]()
              },
            }
          },
          async close() {
            if (taskDomain) {
              state.taskClosed = true
              state.closedBeforePublication = options.publicationFinished?.() === false
            } else {
              state.linksClosed = true
              if (options.linksCloseError) throw options.linksCloseError
            }
          },
        }
      },
    },
  }
}

function context(storage, onRegister = () => {}) {
  const ctx = new Context()
  ctx.provide('webServer', {
    host: '127.0.0.1', port: 12_345,
    register(route) { return onRegister(route) ?? (() => {}) },
  })
  ctx.provide('sessionController', {})
  ctx.provide('storageDomain', storage.facility)
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('attachments', {})
  ctx.provide('fileUploads', {})
  ctx.provide('userQuestions', {})
  return ctx
}

function pluginWithBroker(questions) {
  return {
    name: Bridge.name,
    inject: Bridge.inject,
    apply: (ctx, config) => Bridge.apply(ctx, config, { questions }),
  }
}

function answerMessage() {
  return {
    messageId: 'answer-1', contextId: 'context-1', taskId: 'task-1',
    role: Role.ROLE_USER,
    parts: [{ content: { $case: 'text', value: 'Test' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    metadata: undefined, extensions: [], referenceTaskIds: [],
  }
}

const CONFIG = {
  agent: {
    name: 'Lifecycle Test Agent',
    description: 'Exercise bridge runtime ownership',
    version: '1.0.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{
      id: 'lifecycle',
      name: 'Lifecycle',
      description: 'Exercise listener ownership',
      tags: ['test'],
    }],
  },
}

test('disposal during route registration closes acquired domains and removes routes', async () => {
  const storage = storageFixture()
  let fiber
  let disposal
  let registrations = 0
  let removals = 0
  const ctx = context(storage, () => {
    registrations++
    if (registrations === 1) disposal = fiber.dispose()
    return () => { removals++ }
  })
  try {
    fiber = ctx.plugin(Bridge, CONFIG)
    await fiber
    await disposal
    assert.equal(registrations, 2)
    assert.equal(removals, 2)
    assert.equal(storage.state.taskClosed, true)
    assert.equal(storage.state.linksClosed, true)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('the Cordis listener answers a scoped Task and delegates unrelated Agents and disposed calls', async () => {
  const storage = storageFixture()
  const ctx = context(storage)
  const questions = new Bridge.A2AQuestionBroker()
  const controller = new AbortController()
  const published = deferred()
  const agent = { id: 'session-1' }
  let bridgeScope
  let agentScope
  try {
    await ctx.plugin(inner => {
      bridgeScope = createScope(inner, { id: 'transport' })
      agentScope = createScope(inner, agent)
    })
    const next = async () => ({ answers: [{ id: 'choice', selected: [], custom: 'delegated' }] })
    ctx.on('user-questions/request', next, { global: true })
    const fiber = bridgeScope.ctx.plugin(pluginWithBroker(questions), CONFIG)
    await fiber
    const window = questions.open({
      taskId: Bridge.A2ATaskId('task-1'),
      contextId: Bridge.A2AContextId('context-1'),
      sessionId: 'session-1',
      signal: controller.signal,
      publishInputRequired: async () => { published.resolve() },
      publishWorking: async () => {},
    })
    const request = { agent, questions: [{ id: 'choice', question: 'Which environment?' }] }
    const pending = agentScope.ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', request, next)
    assert.equal(await Promise.race([published.promise.then(() => 'published'), pending.then(() => 'delegated')]), 'published')
    assert.equal(await window.continue(answerMessage()), 'accepted')
    assert.deepEqual(await pending, { answers: [{ id: 'choice', selected: [], custom: 'Test' }] })
    const other = { id: 'session-other' }
    assert.deepEqual(await ctx.waterfall(scopeTarget(other, other), 'user-questions/request', { ...request, agent: other }, next), await next())
    await fiber.dispose()
    assert.deepEqual(await agentScope.ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', request, next), await next())
  } finally {
    controller.abort()
    await questions.close()
    await agentScope?.dispose()
    await bridgeScope?.dispose()
    await ctx.fiber.dispose()
  }
})

test('runtime disposal awaits a real question publication before closing storage', async () => {
  const releasePublication = deferred()
  const enteredPublication = deferred()
  let publicationFinished = false
  const storage = storageFixture({ publicationFinished: () => publicationFinished })
  const routesRemoved = deferred()
  const ctx = context(storage, () => () => { routesRemoved.resolve() })
  const questions = new Bridge.A2AQuestionBroker()
  const controller = new AbortController()
  try {
    const fiber = ctx.plugin(pluginWithBroker(questions), CONFIG)
    await fiber
    questions.open({
      taskId: Bridge.A2ATaskId('task-1'),
      contextId: Bridge.A2AContextId('context-1'),
      sessionId: 'session-1',
      signal: controller.signal,
      publishInputRequired: async () => {
        enteredPublication.resolve()
        await releasePublication.promise
        publicationFinished = true
      },
      publishWorking: async () => {},
    })
    const pending = questions.answer({ agent: { id: 'session-1' }, questions: [{ id: 'choice', question: 'Which?' }] }, async () => ({ answers: [] }))
    void pending.catch(() => {})
    await enteredPublication.promise
    const disposal = fiber.dispose()
    await routesRemoved.promise
    assert.equal(storage.state.taskClosed, false)
    releasePublication.resolve()
    await disposal
    assert.equal(questions.find(Bridge.A2ATaskId('task-1')), undefined)
    await assert.rejects(pending, /aborted/i)
    assert.equal(publicationFinished, true)
    assert.equal(storage.state.closedBeforePublication, false)
    assert.equal(storage.state.taskClosed, true)
  } finally {
    releasePublication.resolve()
    controller.abort()
    await questions.close()
    await ctx.fiber.dispose()
  }
})

test('startup failure aggregates file-link cleanup failure', async () => {
  const startupFailure = new Error('startup recovery failed')
  const cleanupFailure = new Error('file-link close failed')
  const storage = storageFixture({ taskEntriesError: startupFailure, linksCloseError: cleanupFailure })
  const ctx = context(storage)
  try {
    let caught
    try {
      await ctx.plugin(Bridge, CONFIG)
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof AggregateError)
    assert.deepEqual(caught.errors, [startupFailure, cleanupFailure])
    assert.equal(storage.state.taskClosed, true)
    assert.equal(storage.state.linksClosed, true)
  } finally {
    await ctx.fiber.dispose().catch(() => {})
  }
})
