import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const id = '@deepseek-ai/dsh-business-workorder-ui'
const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
let registration
globalThis.window = { __ModuleLoader__: { load(value) { registration = value } } }
new Function(code)()
assert.equal(registration.id, id)
const plugin = registration.factory(specifier => { throw new Error(`unexpected external ${specifier}`) })
assert.equal(typeof plugin.apply, 'function')
assert.deepEqual(plugin.inject, [])

const dataset = {}
globalThis.document = { documentElement: { dataset } }
let dispose
plugin.apply({ effect(callback) { dispose = callback() } })
assert.equal(dataset.businessWorkorderUi, 'ready')
dispose()
assert.equal(dataset.businessWorkorderUi, undefined)
delete globalThis.document
delete globalThis.window
process.stdout.write('business-workorder-ui: client artifact lifecycle passed\n')
