import assert from 'node:assert/strict'
import test from 'node:test'
import * as Bridge from '../lib/index.js'

const { resolveConfig } = Bridge

const AGENT = {
  name: 'Business Agent',
  description: 'Internal business workflow agent',
  version: '0.1.0',
  defaultInputModes: ['text/plain', 'application/json'],
  defaultOutputModes: ['text/plain', 'application/json'],
  skills: [{
    id: 'business-workflows',
    name: 'Business Workflows',
    description: 'Handle configured internal business workflows',
    tags: ['business'],
  }],
}

function resolve(overrides = {}, deployment = {}) {
  return resolveConfig({ agent: AGENT, ...overrides }, {
    host: '127.0.0.1',
    port: 3081,
    env: {},
    ...deployment,
  })
}

test('derives a loopback card and bounded defaults', () => {
  const config = resolve()

  assert.equal(config.route, '/a2a')
  assert.equal(config.cardPath, '/.well-known/agent-card.json')
  assert.equal(config.publicBaseUrl.href, 'http://127.0.0.1:3081/')
  assert.equal(config.requestTimeoutMs, 300_000)
  assert.equal(config.outboundTimeoutMs, 300_000)
  assert.equal(config.maxRequestBytes, 1_048_576)
  assert.equal(config.maxResponseBytes, 4_194_304)
  assert.equal(config.maxConcurrentContexts, 16)
  assert.equal(config.agentCard.name, 'Business Agent')
  assert.deepEqual(config.agentCard.supportedInterfaces, [{
    url: 'http://127.0.0.1:3081/a2a',
    protocolBinding: 'JSONRPC',
    tenant: '',
    protocolVersion: '1.0',
  }])
  assert.deepEqual(config.agentCard.defaultInputModes, ['text/plain', 'application/json'])
  assert.deepEqual(config.agentCard.defaultOutputModes, ['text/plain', 'application/json'])
  assert.deepEqual(config.agentCard.capabilities, {
    streaming: true,
    pushNotifications: false,
    extensions: [],
    extendedAgentCard: false,
  })
  assert.equal(config.agentCard.skills[0].id, 'business-workflows')
})

test('declares bearer security without exposing the token', () => {
  const config = resolve({ bearerTokenEnv: 'BUSINESS_A2A_TOKEN' }, {
    env: { BUSINESS_A2A_TOKEN: 'intranet-secret' },
  })

  assert.equal(config.bearerToken, 'intranet-secret')
  assert.deepEqual(config.agentCard.securitySchemes, {
    bearer: {
      scheme: {
        $case: 'httpAuthSecurityScheme',
        value: { description: 'Bearer token for the A2A JSON-RPC endpoint.', scheme: 'Bearer', bearerFormat: '' },
      },
    },
  })
  assert.deepEqual(config.agentCard.securityRequirements, [{ schemes: { bearer: { list: [] } } }])
  assert.doesNotMatch(JSON.stringify(config.agentCard), /intranet-secret/)
})

test('requires explicit public URL and bearer token on all interfaces', () => {
  assert.throws(() => resolve({}, { host: '0.0.0.0' }), /publicBaseUrl.*required/i)
  assert.throws(() => resolve({ publicBaseUrl: 'http://agent.internal' }, { host: '0.0.0.0' }), /bearerTokenEnv.*required/i)
  assert.throws(() => resolve({
    publicBaseUrl: 'http://agent.internal',
    bearerTokenEnv: 'BUSINESS_A2A_TOKEN',
  }, { host: '0.0.0.0', env: { BUSINESS_A2A_TOKEN: '   ' } }), /non-empty/i)
})

test('rejects unsafe public URLs and routes', () => {
  for (const publicBaseUrl of [
    'ftp://agent.internal',
    'http://user:pass@agent.internal',
    'http://agent.internal?debug=true',
    'http://agent.internal/#details',
  ]) {
    assert.throws(() => resolve({ publicBaseUrl }), /publicBaseUrl/i)
  }
  for (const route of ['a2a', '/', '/a2a?debug=true', '/a2a#fragment']) {
    assert.throws(() => resolve({ route }), /route/i)
  }
})

test('rejects empty identity and limits outside their contracts', () => {
  assert.throws(() => resolve({ agent: { ...AGENT, skills: [] } }), /skill/i)
  assert.throws(() => resolve({ agent: { ...AGENT, name: '  ' } }), /name/i)
  for (const [field, value] of [
    ['requestTimeoutMs', 0],
    ['outboundTimeoutMs', 0],
    ['maxRequestBytes', 0],
    ['maxResponseBytes', 0],
    ['maxConcurrentContexts', 0],
  ]) {
    assert.throws(() => resolve({ [field]: value }), new RegExp(field, 'i'))
  }
})

test('exports a named Cordis plugin entry with its required Host services', () => {
  assert.equal(Bridge.name, 'business-a2a-bridge')
  assert.deepEqual(Bridge.inject, ['webServer', 'sessionController', 'storageDomain', 'tools'])
  assert.equal(typeof Bridge.apply, 'function')
  assert.equal('default' in Bridge, false)
})
