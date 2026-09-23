import assert from 'node:assert/strict'
import { Server } from 'node:net'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as Bridge from '../lib/index.js'

function context() {
  const ctx = new Context()
  ctx.provide('webServer', { host: '127.0.0.1', port: 12_345, register: () => () => {} })
  ctx.provide('sessionController', {})
  ctx.provide('storageDomain', {})
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('attachments', {})
  ctx.provide('fileUploads', {})
  ctx.provide('userQuestions', {})
  return ctx
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

test('disposal during dedicated listener startup closes every acquired resource', async () => {
  const ctx = context()

  let repositoryClosed = false
  let linkRepositoryClosed = false
  const originalOpen = Bridge.StorageDomainA2ARepository.open
  const originalLinkOpen = Bridge.StorageDomainA2AFileLinkRepository.open
  Bridge.StorageDomainA2ARepository.open = async () => ({
    markInterruptedTasksFailed: async () => {},
    close: async () => { repositoryClosed = true },
  })
  Bridge.StorageDomainA2AFileLinkRepository.open = async () => ({
    reapExpired: async () => 0,
    close: async () => { linkRepositoryClosed = true },
  })

  let fiber
  let capturedServer
  let disposal
  const originalListen = Server.prototype.listen
  Server.prototype.listen = function (...args) {
    capturedServer = this
    args[0] = 0
    const result = Reflect.apply(originalListen, this, args)
    disposal = fiber.dispose()
    return result
  }

  try {
    fiber = ctx.plugin(Bridge, {
      ...CONFIG,
      listener: { host: '127.0.0.1', port: 12_346 },
    })
    let startupError
    try {
      await fiber
    } catch (error) {
      startupError = error
    }
    await disposal

    assert.equal(startupError, undefined)
    assert.equal(capturedServer?.listening, false)
    assert.equal(repositoryClosed, true)
    assert.equal(linkRepositoryClosed, true)
  } finally {
    Server.prototype.listen = originalListen
    Bridge.StorageDomainA2ARepository.open = originalOpen
    Bridge.StorageDomainA2AFileLinkRepository.open = originalLinkOpen
    if (capturedServer?.listening) {
      await new Promise(resolve => capturedServer.close(resolve))
    }
    await ctx.fiber.dispose()
  }
})

test('the Cordis question listener delegates and detaches on plugin disposal', async () => {
  const ctx = context()
  const originalTaskOpen = Bridge.StorageDomainA2ARepository.open
  const originalLinkOpen = Bridge.StorageDomainA2AFileLinkRepository.open
  const originalAnswer = Bridge.A2AQuestionBroker.prototype.answer
  let routed = 0
  Bridge.StorageDomainA2ARepository.open = async () => ({
    markInterruptedTasksFailed: async () => 0,
    close: async () => {},
  })
  Bridge.StorageDomainA2AFileLinkRepository.open = async () => ({
    reapExpired: async () => 0,
    close: async () => {},
  })
  Bridge.A2AQuestionBroker.prototype.answer = function (...args) {
    routed++
    return Reflect.apply(originalAnswer, this, args)
  }
  try {
    const fiber = ctx.plugin(Bridge, CONFIG)
    await fiber
    const request = { agent: { id: 'unrelated-session' }, questions: [{ id: 'why', question: 'Why?' }] }
    const next = async () => ({ answers: [{ id: 'why', selected: [], custom: 'delegated' }] })
    assert.deepEqual(await ctx.waterfall('user-questions/request', request, next), await next())
    assert.equal(routed, 1)
    await fiber.dispose()
    assert.deepEqual(await ctx.waterfall('user-questions/request', request, next), await next())
    assert.equal(routed, 1)
  } finally {
    Bridge.A2AQuestionBroker.prototype.answer = originalAnswer
    Bridge.StorageDomainA2ARepository.open = originalTaskOpen
    Bridge.StorageDomainA2AFileLinkRepository.open = originalLinkOpen
    await ctx.fiber.dispose().catch(() => {})
  }
})

test('runtime disposal waits for question publications before closing repositories', async () => {
  const ctx = context()
  const enteredClose = deferred()
  const releaseClose = deferred()
  let repositoryClosed = false
  let closedBeforeQuestions = false
  let questionsClosing = false
  const originalTaskOpen = Bridge.StorageDomainA2ARepository.open
  const originalLinkOpen = Bridge.StorageDomainA2AFileLinkRepository.open
  const originalQuestionClose = Bridge.A2AQuestionBroker.prototype.close
  Bridge.StorageDomainA2ARepository.open = async () => ({
    markInterruptedTasksFailed: async () => 0,
    close: async () => { repositoryClosed = true; closedBeforeQuestions = questionsClosing },
  })
  Bridge.StorageDomainA2AFileLinkRepository.open = async () => ({
    reapExpired: async () => 0,
    close: async () => {},
  })
  Bridge.A2AQuestionBroker.prototype.close = async function () {
    questionsClosing = true
    enteredClose.resolve()
    await releaseClose.promise
    await Reflect.apply(originalQuestionClose, this, [])
    questionsClosing = false
  }
  try {
    const fiber = ctx.plugin(Bridge, CONFIG)
    await fiber
    const disposal = fiber.dispose()
    await enteredClose.promise
    await Promise.resolve()
    assert.equal(repositoryClosed, false)
    releaseClose.resolve()
    await disposal
    assert.equal(repositoryClosed, true)
    assert.equal(closedBeforeQuestions, false)
  } finally {
    releaseClose.resolve()
    Bridge.A2AQuestionBroker.prototype.close = originalQuestionClose
    Bridge.StorageDomainA2ARepository.open = originalTaskOpen
    Bridge.StorageDomainA2AFileLinkRepository.open = originalLinkOpen
    await ctx.fiber.dispose().catch(() => {})
  }
})

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

test('partial startup aggregates its failure with file-link repository cleanup failure', async () => {
  const ctx = context()
  const startupFailure = new Error('startup recovery failed')
  const cleanupFailure = new Error('file-link close failed')
  let taskClosed = false
  const originalTaskOpen = Bridge.StorageDomainA2ARepository.open
  const originalLinkOpen = Bridge.StorageDomainA2AFileLinkRepository.open
  Bridge.StorageDomainA2ARepository.open = async () => ({
    markInterruptedTasksFailed: async () => { throw startupFailure },
    close: async () => { taskClosed = true },
  })
  Bridge.StorageDomainA2AFileLinkRepository.open = async () => ({
    reapExpired: async () => 0,
    close: async () => { throw cleanupFailure },
  })

  try {
    let caught
    try {
      await ctx.plugin(Bridge, CONFIG)
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof AggregateError)
    assert.deepEqual(caught.errors, [startupFailure, cleanupFailure])
    assert.equal(taskClosed, true)
  } finally {
    Bridge.StorageDomainA2ARepository.open = originalTaskOpen
    Bridge.StorageDomainA2AFileLinkRepository.open = originalLinkOpen
    await ctx.fiber.dispose().catch(() => {})
  }
})
