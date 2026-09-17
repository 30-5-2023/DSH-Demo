import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply, name } from '../lib/index.js'

assert.equal(name, 'business-workorder-host')
const lines = []
const original = console.log
console.log = line => lines.push(line)
try {
  const ctx = new Context()
  const fiber = ctx.plugin({ apply })
  await fiber.await()
  assert.deepEqual(lines, ['business-workorder-host: ready'])
  await fiber.dispose()
} finally {
  console.log = original
}
process.stdout.write('business-workorder-host: startup lifecycle passed\n')
