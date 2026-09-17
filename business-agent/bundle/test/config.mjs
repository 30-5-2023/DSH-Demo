import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from 'js-yaml'

const entries = load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
assert.ok(Array.isArray(entries))
const inserted = entries.flatMap(entry => entry.insert ?? [])
assert.deepEqual(inserted.map(entry => entry.id), [
  'business-workorder-host', 'business-workorder-mcp', 'business-workorder-ui',
])
assert.deepEqual(inserted.map(entry => entry.name), [
  '@deepseek-ai/dsh-business-workorder-host',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-business-workorder-ui',
])
const mcp = inserted.find(entry => entry.id === 'business-workorder-mcp')
assert.deepEqual(mcp.config, {
  serverName: 'workorder',
  transport: 'streamable-http',
  url: 'http://127.0.0.1:8090/mcp',
  failOnStartupError: true,
})
process.stdout.write('business-agent bundle: config skeleton passed\n')
