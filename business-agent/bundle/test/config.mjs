import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import { resolveConfig } from '@deepseek-ai/dsh-business-a2a-bridge'

const source = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

function loadEntries(env = {}) {
  const javascript = new Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct(expression) {
      switch (expression) {
        case "process.env.A2A_LISTEN_HOST ?? '127.0.0.1'":
          return env.A2A_LISTEN_HOST ?? '127.0.0.1'
        case 'Number(process.env.A2A_LISTEN_PORT ?? 3082)':
          return Number(env.A2A_LISTEN_PORT ?? 3082)
        case 'process.env.A2A_PUBLIC_BASE_URL':
          return env.A2A_PUBLIC_BASE_URL
        case 'Number(process.env.A2A_INLINE_FILE_MAX_BYTES ?? 1048576)':
          return Number(env.A2A_INLINE_FILE_MAX_BYTES ?? 1048576)
        case 'Number(process.env.A2A_MAX_FILE_BYTES ?? 268435456)':
          return Number(env.A2A_MAX_FILE_BYTES ?? 268435456)
        case 'Number(process.env.A2A_FILE_RETENTION_MS ?? 86400000)':
          return Number(env.A2A_FILE_RETENTION_MS ?? 86400000)
        case "(process.env.A2A_FILE_URL_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)":
          return (env.A2A_FILE_URL_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)
        case "(process.env.A2A_PUBLISH_FILE_ALLOWED_ROOTS ?? '').split(',').map(value => value.trim()).filter(Boolean)":
          return (env.A2A_PUBLISH_FILE_ALLOWED_ROOTS ?? '').split(',').map(value => value.trim()).filter(Boolean)
        default:
          throw new Error(`business-agent bundle test: unsupported !!js expression: ${expression}`)
      }
    },
  })
  return load(source, { schema: DEFAULT_SCHEMA.extend([javascript]) })
}

const entries = loadEntries()
assert.ok(Array.isArray(entries))
assert.deepEqual(entries.slice(0, 2), [
  { id: 'ui-sidebar-terminal', disabled: true },
  { id: 'ui-sidebar-files', disabled: true },
])
const inserted = entries.flatMap(entry => entry.insert ?? [])
assert.deepEqual(inserted.map(entry => entry.id), [
  'business-workorder-host', 'business-workorder-mcp', 'business-workorder-ui', 'business-workorder-debug',
  'business-a2a-bridge',
])
assert.deepEqual(inserted.map(entry => entry.name), [
  '@deepseek-ai/dsh-business-workorder-host',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-business-workorder-ui',
  '@deepseek-ai/dsh-business-workorder-debug',
  '@deepseek-ai/dsh-business-a2a-bridge',
])
const host = inserted.find(entry => entry.id === 'business-workorder-host')
assert.deepEqual(host.config, {
  serviceUrl: 'http://127.0.0.1:8090',
  maxConsecutiveWakes: 3,
  reconnectInitialDelayMs: 500,
  reconnectMaxDelayMs: 10000,
})
const mcp = inserted.find(entry => entry.id === 'business-workorder-mcp')
assert.deepEqual(mcp.config, {
  serverName: 'workorder',
  transport: 'streamable-http',
  url: 'http://127.0.0.1:8090/mcp',
  failOnStartupError: true,
})
const debug = inserted.find(entry => entry.id === 'business-workorder-debug')
assert.deepEqual(debug.config, {
  serviceUrl: 'http://127.0.0.1:8090',
  orderId: 'WO-MVP-001',
  traceLimit: 100,
})
const a2a = inserted.find(entry => entry.id === 'business-a2a-bridge')
assert.deepEqual(a2a.config, {
  route: '/a2a',
  listener: { host: '127.0.0.1', port: 3082 },
  publicBaseUrl: undefined,
  agent: {
    name: 'Business Agent',
    description: 'Internal business workflow agent',
    version: '0.1.0',
    defaultInputModes: ['text/plain', 'application/json', 'application/octet-stream'],
    defaultOutputModes: ['text/plain', 'application/json', 'application/octet-stream'],
    skills: [{
      id: 'business-workflows',
      name: 'Business Workflows',
      description: 'Handle configured internal business workflows',
      tags: ['business'],
    }],
  },
  requestTimeoutMs: 300000,
  outboundTimeoutMs: 300000,
  maxRequestBytes: 2097152,
  maxResponseBytes: 4194304,
  maxConcurrentContexts: 16,
  inlineFileMaxBytes: 1048576,
  maxFileBytes: 268435456,
  fileRetentionMs: 86400000,
  fileUrlAllowedOrigins: [],
  publishFileAllowedRoots: [],
})
const intranetA2A = loadEntries({
  A2A_LISTEN_HOST: '0.0.0.0',
  A2A_LISTEN_PORT: '3182',
  A2A_PUBLIC_BASE_URL: 'http://agent.internal:3182',
  A2A_INLINE_FILE_MAX_BYTES: '524288',
  A2A_MAX_FILE_BYTES: '134217728',
  A2A_FILE_RETENTION_MS: '3600000',
  A2A_FILE_URL_ALLOWED_ORIGINS: 'http://files.internal:8080, https://objects.internal',
  A2A_PUBLISH_FILE_ALLOWED_ROOTS: '/srv/a2a-files, /mnt/generated',
}).flatMap(entry => entry.insert ?? []).find(entry => entry.id === 'business-a2a-bridge')
assert.deepEqual(intranetA2A.config.listener, { host: '0.0.0.0', port: 3182 })
assert.equal(intranetA2A.config.publicBaseUrl, 'http://agent.internal:3182')
assert.equal(intranetA2A.config.inlineFileMaxBytes, 524288)
assert.equal(intranetA2A.config.maxFileBytes, 134217728)
assert.equal(intranetA2A.config.fileRetentionMs, 3600000)
assert.deepEqual(intranetA2A.config.fileUrlAllowedOrigins, [
  'http://files.internal:8080', 'https://objects.internal',
])
assert.deepEqual(intranetA2A.config.publishFileAllowedRoots, ['/srv/a2a-files', '/mnt/generated'])
resolveConfig(intranetA2A.config, { host: '127.0.0.1', port: 3081, env: {} })

for (const env of [
  { A2A_INLINE_FILE_MAX_BYTES: 'not-a-number' },
  { A2A_MAX_FILE_BYTES: '0' },
  { A2A_FILE_RETENTION_MS: '1000' },
  { A2A_FILE_URL_ALLOWED_ORIGINS: 'http://files.internal/path' },
  { A2A_PUBLISH_FILE_ALLOWED_ROOTS: 'relative/path' },
]) {
  const invalid = loadEntries(env).flatMap(entry => entry.insert ?? [])
    .find(entry => entry.id === 'business-a2a-bridge')
  assert.throws(() => resolveConfig(invalid.config, { host: '127.0.0.1', port: 3081, env: {} }))
}
process.stdout.write('business-agent bundle: config skeleton passed\n')
