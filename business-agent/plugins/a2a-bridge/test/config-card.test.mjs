import assert from 'node:assert/strict'
import { resolve as resolvePath } from 'node:path'
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
  assert.equal(config.maxRequestBytes, 2_097_152)
  assert.equal(config.maxResponseBytes, 4_194_304)
  assert.equal(config.maxConcurrentContexts, 16)
  assert.equal(config.inlineFileMaxBytes, 1_048_576)
  assert.equal(config.maxFileBytes, 268_435_456)
  assert.equal(config.fileRetentionMs, 86_400_000)
  assert.deepEqual(config.fileUrlAllowedOrigins, [])
  assert.deepEqual(config.publishFileAllowedRoots, [])
  assert.equal(config.agentCard.name, 'Business Agent')
  assert.deepEqual(config.agentCard.supportedInterfaces, [{
    url: 'http://127.0.0.1:3081/a2a',
    protocolBinding: 'JSONRPC',
    tenant: '',
    protocolVersion: '1.0',
  }, {
    url: 'http://127.0.0.1:3081/a2a',
    protocolBinding: 'JSONRPC',
    tenant: '',
    protocolVersion: '0.3',
  }])
  assert.deepEqual(resolve().agentCard.supportedInterfaces, config.agentCard.supportedInterfaces)
  assert.deepEqual(config.agentCard.defaultInputModes, ['text/plain', 'application/json', 'application/octet-stream'])
  assert.deepEqual(config.agentCard.defaultOutputModes, ['text/plain', 'application/json', 'application/octet-stream'])
  assert.deepEqual(config.agentCard.capabilities, {
    streaming: true,
    pushNotifications: false,
    extensions: [],
    extendedAgentCard: false,
  })
  assert.equal(config.agentCard.skills[0].id, 'business-workflows')
})

test('keeps listener absent when an existing profile omits it', () => {
  const parsed = Bridge.Config({ agent: AGENT })
  assert.equal(parsed.listener, undefined)
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

test('validates dedicated listener addresses without requiring research authentication', () => {
  assert.throws(() => resolve({}, { host: '0.0.0.0' }), /publicBaseUrl.*required/i)
  const wildcard = resolve({
    listener: { host: '0.0.0.0', port: 3082 },
    publicBaseUrl: 'http://agent.internal:3082',
  })
  assert.deepEqual(wildcard.listener, { host: '0.0.0.0', port: 3082 })
  assert.equal(wildcard.bearerToken, undefined)
  assert.equal(wildcard.agentCard.supportedInterfaces[0].url, 'http://agent.internal:3082/a2a')

  assert.equal(resolve({ listener: { host: '127.0.0.1', port: 3182 } }).publicBaseUrl.href, 'http://127.0.0.1:3182/')
  assert.throws(() => resolve({ listener: { host: '192.168.1.10', port: 3082 } }), /listener.host/i)
  assert.throws(() => resolve({ listener: { host: '127.0.0.1', port: 0 } }), /listener.port/i)
  assert.throws(() => resolve({ listener: { host: '127.0.0.1', port: 65_536 } }), /listener.port/i)
  assert.throws(() => resolve({ listener: { host: '0.0.0.0', port: 3082 } }), /publicBaseUrl.*required/i)
  assert.throws(() => resolve({
    listener: { host: '0.0.0.0', port: 3082 },
    publicBaseUrl: 'http://0.0.0.0:3082',
  }), /publicBaseUrl.*0\.0\.0\.0/i)

  assert.throws(() => resolve({
    listener: { host: '0.0.0.0', port: 3082 },
    publicBaseUrl: 'http://agent.internal',
    bearerTokenEnv: 'BUSINESS_A2A_TOKEN',
  }, { env: { BUSINESS_A2A_TOKEN: '   ' } }), /non-empty/i)
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

test('validates and canonicalizes file transfer policy', () => {
  const root = resolvePath('allowed-a2a-files')
  const config = resolve({
    inlineFileMaxBytes: 64,
    maxFileBytes: 128,
    maxRequestBytes: 65_624,
    fileRetentionMs: 60_000,
    fileUrlAllowedOrigins: ['http://files.internal', 'https://files.internal:8443'],
    publishFileAllowedRoots: [root],
  })
  assert.equal(config.inlineFileMaxBytes, 64)
  assert.equal(config.maxFileBytes, 128)
  assert.equal(config.fileRetentionMs, 60_000)
  assert.deepEqual(config.fileUrlAllowedOrigins, ['http://files.internal', 'https://files.internal:8443'])
  assert.deepEqual(config.publishFileAllowedRoots, [root])

  assert.throws(() => resolve({ inlineFileMaxBytes: 129, maxFileBytes: 128 }), /inlineFileMaxBytes.*maxFileBytes/i)
  assert.throws(() => resolve({ inlineFileMaxBytes: 64, maxRequestBytes: 65_623 }), /maxRequestBytes.*inlineFileMaxBytes/i)
  assert.throws(() => resolve({ fileRetentionMs: 59_999 }), /fileRetentionMs/i)
  assert.throws(() => resolve({ fileRetentionMs: 30 * 24 * 60 * 60 * 1_000 + 1 }), /fileRetentionMs/i)
  for (const origin of [
    'ftp://files.internal',
    'http://user:pass@files.internal',
    'http://files.internal/path',
    'http://files.internal?download=true',
    'http://files.internal/#fragment',
  ]) {
    assert.throws(() => resolve({ fileUrlAllowedOrigins: [origin] }), /fileUrlAllowedOrigins/i)
  }
  assert.throws(() => resolve({ publishFileAllowedRoots: ['relative/files'] }), /publishFileAllowedRoots/i)
})

test('exports a named Cordis plugin entry with its required Host services', () => {
  assert.equal(Bridge.name, 'business-a2a-bridge')
  assert.deepEqual(Bridge.inject, [
    'webServer', 'sessionController', 'storageDomain', 'tools', 'attachments', 'fileUploads',
  ])
  assert.equal(typeof Bridge.apply, 'function')
  assert.equal('default' in Bridge, false)
})
