import assert from 'node:assert/strict'
import { Server } from 'node:net'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as Bridge from '../lib/index.js'

test('disposal during dedicated listener startup closes every acquired resource', async () => {
  const ctx = new Context()
  ctx.provide('webServer', { host: '127.0.0.1', port: 12_345 })
  ctx.provide('sessionController', {})
  ctx.provide('storageDomain', {})
  ctx.provide('tools', { register: () => () => {} })

  let repositoryClosed = false
  const originalOpen = Bridge.StorageDomainA2ARepository.open
  Bridge.StorageDomainA2ARepository.open = async () => ({
    markInterruptedTasksFailed: async () => {},
    close: async () => { repositoryClosed = true },
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
      listener: { host: '127.0.0.1', port: 12_346 },
      agent: {
        name: 'Lifecycle Test Agent',
        description: 'Exercise disposal while the dedicated listener is binding',
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
  } finally {
    Server.prototype.listen = originalListen
    Bridge.StorageDomainA2ARepository.open = originalOpen
    if (capturedServer?.listening) {
      await new Promise(resolve => capturedServer.close(resolve))
    }
    await ctx.fiber.dispose()
  }
})
