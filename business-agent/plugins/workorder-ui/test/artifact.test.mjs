import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const id = '@deepseek-ai/dsh-business-workorder-ui'
const host = await import('../lib/index.js')
const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
let registration
const styles = []
globalThis.document = {
  querySelector() { return null },
  createElement() { return { dataset: {}, textContent: '' } },
  head: { appendChild(value) { styles.push(value) } },
}
globalThis.__DSH_BUSINESS_WORKORDER__ = {
  serviceUrl: 'http://127.0.0.1:8090',
  orderId: 'WO-MVP-001',
}
globalThis.window = { __ModuleLoader__: { load(value) { registration = value } } }
new Function(code)()
assert.equal(registration.id, id)

let indexListener
host.apply({
  on(event, listener) {
    assert.equal(event, 'webserver/index-inject')
    indexListener = listener
  },
}, globalThis.__DSH_BUSINESS_WORKORDER__)
const injections = []
indexListener(injections)
assert.deepEqual(injections, [{
  kind: 'global',
  name: '__DSH_BUSINESS_WORKORDER__',
  value: globalThis.__DSH_BUSINESS_WORKORDER__,
}])
assert.throws(() => host.apply({ on() {} }, { serviceUrl: 'file:///tmp/order', orderId: 'WO-MVP-001' }))

const noop = () => undefined
const plugin = registration.factory(specifier => {
  if (specifier === 'react/jsx-runtime') return { jsx: noop, jsxs: noop, Fragment: Symbol('Fragment') }
  if (specifier === 'react') return { useCallback: noop, useEffect: noop, useRef: noop, useState: noop }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return new Proxy({}, { get: () => noop })
  }
  throw new Error(`unexpected external ${specifier}`)
})
assert.equal(typeof plugin.apply, 'function')
assert.deepEqual(plugin.inject, ['slots', 'locale', 'sidebarRightTabs'])
assert.equal(styles.length, 1)
assert.match(styles[0].textContent, /data-status/)

const registered = { effects: [], definition: undefined, dictionaries: undefined, slot: undefined }
const translate = key => `translated:${key}`
plugin.apply({
  effect(callback, label) {
    registered.effects.push(label)
    return callback()
  },
  locale: {
    bind(namespace) {
      assert.equal(namespace, 'businessWorkorder')
      return translate
    },
    register(namespace, dictionaries) {
      assert.equal(namespace, 'businessWorkorder')
      registered.dictionaries = dictionaries
      return noop
    },
  },
  sidebarRightTabs: {
    register(definition) {
      registered.definition = definition
      return noop
    },
  },
  slots: {
    inject(name, callback) {
      assert.equal(name, 'sidebar.right.pane.tab')
      return callback()
    },
    register(options, component) {
      registered.slot = { options, component }
      return noop
    },
  },
})

assert.deepEqual(registered.effects, [
  'business-workorder-ui: work-order type',
  'business-workorder-ui: dictionaries',
  'business-workorder-ui: work-order body',
])
assert.equal(registered.definition.id, id)
assert.equal(registered.definition.kind, 'business-workorder')
assert.equal(registered.definition.title(), 'translated:type.label')
assert.equal(registered.definition.guide[0].title(), 'translated:guide.title')
assert.equal(registered.dictionaries.zh['status.waiting'], '等待处理')
assert.equal(registered.dictionaries.en['status.done'], 'Done')
assert.deepEqual(registered.slot.options, {
  name: 'sidebar.right.pane.tab',
  key: id,
  locale: 'businessWorkorder',
})
assert.equal(typeof registered.slot.component, 'function')

const snapshot = plugin.parseOrderSnapshot({
  rev: 4,
  order: {
    id: 'WO-MVP-001', title: 'Long work-order title', status: 'waiting', owner: 'Operations', currentActivitySeq: 2,
    activities: [
      {
        id: 'manual', seq: 2, title: 'Review', type: 'manual', automation: 'manual', status: 'waiting', needsHuman: true,
        inputs: [{ resourceId: 'input-1', name: 'report.md', fromActivitySeq: 1 }], outputs: [],
        startedAt: '2026-09-18T00:00:00.000Z', finishedAt: null,
      },
      {
        id: 'automatic', seq: 1, title: 'Check', type: 'tool', automation: 'auto', status: 'done', needsHuman: false,
        inputs: [], outputs: [{ resourceId: 'input-1', name: 'report.md', kind: 'file' }],
        startedAt: '2026-09-18T00:00:00.000Z', finishedAt: '2026-09-18T00:00:01.000Z',
      },
    ],
  },
})
assert.equal(snapshot.order.activities[0].id, 'automatic')
assert.equal(snapshot.order.activities[1].inputs[0].resourceId, 'input-1')
assert.throws(() => plugin.parseOrderSnapshot({ rev: 1, order: { status: 'invented' } }))
assert.equal(plugin.parseEventRevision('{"rev":8}'), 8)
assert.equal(plugin.parseEventRevision('{"rev":-1}'), undefined)
assert.equal(plugin.parseEventRevision('not-json'), undefined)

delete globalThis.document
delete globalThis.window
delete globalThis.__DSH_BUSINESS_WORKORDER__
process.stdout.write('business-workorder-ui: artifact registration and wire validation passed\n')
