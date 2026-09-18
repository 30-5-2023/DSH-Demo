import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const id = '@deepseek-ai/dsh-business-workorder-debug'
const noop = () => undefined
const host = await import('../lib/index.js')
const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
let registration
const styles = []
globalThis.document = {
  querySelector() { return null },
  createElement() { return { dataset: {}, textContent: '' } },
  head: { appendChild(value) { styles.push(value) } },
}
globalThis.__DSH_BUSINESS_WORKORDER_DEBUG__ = {
  serviceUrl: 'http://127.0.0.1:8090',
  orderId: 'WO-MVP-001',
}
globalThis.window = { __ModuleLoader__: { load(value) { registration = value } } }
new Function(code)()
assert.equal(registration.id, id)

const listeners = new Map()
const effects = []
let traceRoute
let traceListener
host.apply({
  on(event, listener) {
    listeners.set(event, listener)
  },
  effect(callback, label) {
    effects.push(label)
    return callback()
  },
  webServer: {
    register(route) {
      traceRoute = route
      return noop
    },
  },
  businessWorkorderWakeTraces: {
    subscribe(listener) {
      traceListener = listener
      return noop
    },
  },
}, { ...globalThis.__DSH_BUSINESS_WORKORDER_DEBUG__, traceLimit: 2 })
const injections = []
listeners.get('webserver/index-inject')(injections)
assert.deepEqual(injections, [{
  kind: 'global',
  name: '__DSH_BUSINESS_WORKORDER_DEBUG__',
  value: globalThis.__DSH_BUSINESS_WORKORDER_DEBUG__,
}])
assert.deepEqual(host.inject, ['webServer', 'businessWorkorderWakeTraces'])
assert.deepEqual(effects, [
  'business-workorder-debug: wake trace subscription',
  'business-workorder-debug: GET /debug/business-workorder/wake-traces',
])
assert.equal(traceRoute.kind, 'exact')
assert.equal(traceRoute.path, '/debug/business-workorder/wake-traces')
traceListener({
  trigger: 'service-event',
  decision: 'followup',
  event: {
    type: 'activity.changed',
    rev: 7,
    orderId: 'WO-MVP-001',
    orderTitle: 'Annual credit review',
    activityId: 'activity-manual-review',
    activitySeq: 3,
    activityTitle: 'Review statements',
    from: 'pending',
    to: 'waiting',
    needsHuman: true,
    line: 'Step 3 requires a reviewer',
    at: '2026-09-18T00:00:00.000Z',
  },
  sessionId: 'session-primary',
  agentStatus: 'idle',
  message: { role: 'user', content: [{ type: 'text', text: 'wake' }] },
})
const response = {
  status: undefined,
  headers: undefined,
  chunks: [],
  writeHead(status, headers) { this.status = status; this.headers = headers },
  write(chunk) { this.chunks.push(chunk) },
  on() {},
  end() {},
  destroy() {},
}
traceRoute.handler({ method: 'GET' }, response)
assert.equal(response.status, 200)
assert.match(response.headers['content-type'], /^text\/event-stream/)
assert.match(response.chunks[0], /"decision":"followup"/)
assert.match(response.chunks[0], /"limit":2/)
assert.throws(() => host.apply({ on() {} }, { serviceUrl: 'file:///tmp/order', orderId: 'WO-MVP-001', traceLimit: 2 }))

const plugin = registration.factory(specifier => {
  if (specifier === 'react/jsx-runtime') return { jsx: noop, jsxs: noop, Fragment: Symbol('Fragment') }
  if (specifier === 'react') return { useCallback: noop, useEffect: noop, useState: noop }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return new Proxy({}, { get: () => noop })
  }
  throw new Error(`unexpected external ${specifier}`)
})
assert.equal(typeof plugin.apply, 'function')
assert.deepEqual(plugin.inject, ['slots', 'locale'])
assert.equal(styles.length, 1)
assert.match(styles[0].textContent, /data-collapsed/)

const registered = { effects: [], dictionaries: undefined, slot: undefined }
plugin.apply({
  effect(callback, label) {
    registered.effects.push(label)
    return callback()
  },
  locale: {
    register(namespace, dictionaries) {
      assert.equal(namespace, 'businessWorkorderDebug')
      registered.dictionaries = dictionaries
      return noop
    },
  },
  slots: {
    inject(name, callback) {
      assert.equal(name, 'shell.overlay')
      return callback()
    },
    register(options, component) {
      registered.slot = { options, component }
      return noop
    },
  },
})

assert.deepEqual(registered.effects, [
  'business-workorder-debug: dictionaries',
  'business-workorder-debug: floating card',
])
assert.equal(registered.dictionaries.zh['reset.action'], '重置工单')
assert.equal(registered.dictionaries.en['reset.action'], 'Reset work order')
assert.deepEqual(registered.slot.options, {
  name: 'shell.overlay',
  id: 'business-workorder-debug',
  order: 1_000,
  locale: 'businessWorkorderDebug',
})
assert.equal(typeof registered.slot.component, 'function')

delete globalThis.document
delete globalThis.window
delete globalThis.__DSH_BUSINESS_WORKORDER_DEBUG__
process.stdout.write('business-workorder-debug: artifact registration passed\n')
