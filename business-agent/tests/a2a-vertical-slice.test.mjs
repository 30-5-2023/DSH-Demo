import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { Role, TaskState } from '@a2a-js/sdk'
import {
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  auditStartupEntries,
  createProfileResolutionGeneration,
  loadOverlayPatches,
  PluginPackages,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const installAnchor = join(repoRoot, 'apps/cli/package.json')
const basePatch = join(repoRoot, 'packages/bundle/base/cordis.patch.yml')
const webPatch = join(repoRoot, 'packages/bundle/web-app/cordis.patch.yml')
const businessBundle = join(repoRoot, 'business-agent/bundle')
const businessPatch = join(businessBundle, 'cordis.patch.yml')
const scriptedLlm = join(repoRoot, 'business-agent/tests/fixtures/a2a-scripted-llm.ts')

function message(messageId, text, contextId = '') {
  return {
    tenant: '',
    message: {
      messageId,
      contextId,
      taskId: '',
      role: Role.ROLE_USER,
      parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: ['text/plain'],
      taskPushNotificationConfig: undefined,
      returnImmediately: false,
    },
    metadata: undefined,
  }
}

function taskOutput(task) {
  return task.artifacts.flatMap(artifact => artifact.parts)
    .filter(part => part.content?.$case === 'text')
    .map(part => part.content.value)
    .join('')
}

async function writeOverlay(root, storageRoot, sessionsRoot) {
  const overlay = join(root, 'a2a-test.patch.yml')
  const yamlPath = value => value.replaceAll('\\', '/')
  await writeFile(overlay, [
    '- id: session-title-llm',
    '  disabled: true',
    '- id: session-telemetry-otel',
    '  disabled: true',
    '- id: llm-deepseek',
    '  disabled: true',
    '- id: business-workorder-host',
    '  disabled: true',
    '- id: business-workorder-mcp',
    '  disabled: true',
    '- id: business-workorder-ui',
    '  disabled: true',
    '- id: business-workorder-debug',
    '  disabled: true',
    '- id: webserver',
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '    compression: none',
    '    compressionLevel: 1',
    '    compressionThresholdBytes: 1024',
    '- id: web-runtime',
    '  config:',
    '    openBrowser: false',
    '    printUrl: false',
    '    surfaceContext: false',
    '- id: settings',
    '  config:',
    `    dshHome: '${yamlPath(join(root, 'home'))}'`,
    '- id: credentials',
    '  config:',
    `    dshHome: '${yamlPath(join(root, 'home'))}'`,
    '- id: storage-json',
    '  config:',
    `    root: '${yamlPath(storageRoot)}'`,
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: '${yamlPath(sessionsRoot)}'`,
    '    compression: none',
    '- id: business-a2a-bridge',
    '  config:',
    '    route: /a2a',
    "    publicBaseUrl: !!js \"'http://127.0.0.1:' + ctx.webServer.port\"",
    '    agent:',
    '      name: Business Agent Test',
    '      description: Loader-composed A2A test agent',
    '      version: 0.1.0',
    '      defaultInputModes: [text/plain, application/json]',
    '      defaultOutputModes: [text/plain, application/json]',
    '      skills:',
    '        - id: test',
    '          name: Test',
    '          description: Execute deterministic test messages',
    '          tags: [test]',
    '    requestTimeoutMs: 5000',
    '    outboundTimeoutMs: 5000',
    '    maxRequestBytes: 2097152',
    '    maxResponseBytes: 1048576',
    '    maxConcurrentContexts: 4',
    '- insert:',
    '    - id: business-a2a-scripted-llm',
    `      name: '${yamlPath(scriptedLlm)}'`,
    '',
  ].join('\n'))
  return overlay
}

async function bootWorld(root) {
  const profileDir = join(root, 'profile')
  const home = join(root, 'home')
  const storageRoot = join(root, 'storage')
  const sessionsRoot = join(root, 'sessions')
  await mkdir(profileDir, { recursive: true })
  const rootConfig = join(profileDir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  const overlay = await writeOverlay(root, storageRoot, sessionsRoot)
  const profile = {
    name: 'a2a-test',
    dir: profileDir,
    layers: [{
      packageName: '@deepseek-ai/dsh-business-agent',
      packageDir: businessBundle,
      patchPath: businessPatch,
      patches: [],
    }],
    patchPath: join(profileDir, 'cordis.patch.yml'),
    patches: [],
    patchReload: 'startup',
  }
  const generation = await createProfileResolutionGeneration({ installAnchor, home, profile })
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(profileDir).href + '/'
  ctx.provide('dshHomePath', (...segments) => join(home, ...segments))
  provideCmdline(ctx, {
    args: [],
    exit: code => { throw new Error(`A2A test profile requested exit ${code}`) },
  })
  try {
    await ctx.plugin(PluginPackages, { generation, behavior: 'enforce' })
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    await ctx.loader.create({
      name: 'cordis:include',
      config: {
        path: pathToFileURL(rootConfig).href,
        patches: [
          ...loadOverlayPatches('a2a vertical slice', basePatch),
          ...loadOverlayPatches('a2a vertical slice', webPatch),
          ...loadOverlayPatches('a2a vertical slice', businessPatch),
          ...loadOverlayPatches('a2a vertical slice', overlay),
        ],
      },
    })
    await ctx.loader.await()
    await auditStartupEntries(ctx, 'a2a vertical slice')
    const port = ctx.webServer.port
    return {
      ctx,
      cardUrl: `http://127.0.0.1:${port}/.well-known/agent-card.json`,
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

async function officialClient(cardUrl) {
  const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [new JsonRpcTransportFactory()],
  }))
  return await factory.createFromUrl(cardUrl, '')
}

test('real Loader answers two questions on one durable A2A Task and Session', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'business-a2a-question-'))
  let world
  try {
    world = await bootWorld(root)
    const client = await officialClient(world.cardUrl)
    const pending = await client.sendMessage(message('question-start', 'question'))
    assert.equal(pending.status.state, TaskState.TASK_STATE_INPUT_REQUIRED, JSON.stringify(pending))
    const question = pending.status.message
    assert.match(question.parts.find(part => part.content?.$case === 'text').content.value, /Environment[\s\S]*Priority/)
    const data = question.parts.find(part => part.content?.$case === 'data').content.value
    assert.equal(data.schema, 'urn:deepseek-harness:a2a:input-required:v1')
    assert.deepEqual(data.questions.map(item => ({ id: item.id, options: item.options.map(option => option.label) })), [
      { id: 'environment', options: ['Development', 'Test'] },
      { id: 'priority', options: ['Normal', 'Urgent'] },
    ])
    const fetched = await client.getTask({ tenant: '', id: pending.id, historyLength: 100 })
    assert.equal(fetched.status.state, TaskState.TASK_STATE_INPUT_REQUIRED)
    assert.deepEqual(fetched.status.message, question)
    const answer = message('question-answer', '', pending.contextId)
    answer.message.taskId = pending.id
    answer.message.parts = [{
      content: { $case: 'data', value: {
        schema: 'urn:deepseek-harness:a2a:input-response:v1',
        answers: [
          { id: 'environment', selected: ['Test'] },
          { id: 'priority', selected: ['Urgent'] },
        ],
      } }, metadata: undefined, filename: '', mediaType: 'application/json',
    }]
    const completed = await client.sendMessage(answer)
    assert.equal(completed.id, pending.id)
    assert.equal(completed.contextId, pending.contextId)
    assert.equal(completed.status.state, TaskState.TASK_STATE_COMPLETED)
    assert.equal(taskOutput(completed), 'selected:environment=Test;priority=Urgent')
    const retained = await client.getTask({ tenant: '', id: pending.id, historyLength: 100 })
    for (const id of ['question-start', question.messageId, 'question-answer']) {
      assert.ok(retained.history.some(item => item.messageId === id), `Task history retains ${id}`)
    }
    const cardUrl = world.cardUrl
    await world.ctx.fiber.dispose()
    world = undefined
    await assert.rejects(fetch(cardUrl, { signal: AbortSignal.timeout(5000) }), /fetch failed/)
    const sessionFiles = (await readdir(join(root, 'sessions'), { recursive: true }))
      .filter(path => path.endsWith('.jsonl'))
    assert.equal(sessionFiles.length, 1)
    const log = await readFile(join(root, 'sessions', sessionFiles[0]), 'utf8')
    assert.match(log, /ask_user_question/)
    assert.match(log, /selected:environment=Test;priority=Urgent/)
    const events = log.trim().split('\n').map(line => JSON.parse(line))
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1)
    const result = results[0].data.message.content[0]
    assert.equal(result.toolCallId, 'a2a-question')
    assert.notEqual(result.isError, true)
    assert.deepEqual(JSON.parse(result.content.map(block => block.text).join('')), {
      answers: [{ id: 'environment', selected: ['Test'] }, { id: 'priority', selected: ['Urgent'] }],
    })
  } finally {
    await world?.ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('real Loader composition serves durable A2A sync, stream, lookup, cancel, and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'business-a2a-vertical-'))
  let world
  let peer
  try {
    const primaryRoot = join(root, 'primary')
    world = await bootWorld(primaryRoot)
    peer = await bootWorld(join(root, 'peer'))
    let client = await officialClient(world.cardUrl)

    const discovered = await (await fetch(world.cardUrl)).json()
    assert.equal(discovered.name, 'Business Agent Test')

    const outbound = await world.ctx.tools.execute({
      callId: 'vertical-outbound',
      name: 'call_a2a_agent',
      arguments: {
        agent_card_url: peer.cardUrl,
        message: 'peer-call',
        stream: false,
      },
      signal: new AbortController().signal,
    })
    assert.equal(outbound.isError, false)
    assert.equal(outbound.value.state, 'TASK_STATE_COMPLETED')
    assert.equal(outbound.value.output, 'reply:peer-call:turns=1')

    const first = await client.sendMessage(message('vertical-first', 'one'))
    assert.equal(first.status.state, TaskState.TASK_STATE_COMPLETED)
    assert.equal(taskOutput(first), 'reply:one:turns=1')
    const second = await client.sendMessage(message('vertical-second', 'two', first.contextId))
    assert.equal(second.contextId, first.contextId)
    assert.equal(taskOutput(second), 'reply:two:turns=2')
    const separate = await client.sendMessage(message('vertical-separate', 'other'))
    assert.notEqual(separate.contextId, first.contextId)
    assert.equal(taskOutput(separate), 'reply:other:turns=1')

    let streamed
    for await (const event of client.sendMessageStream(message('vertical-stream', 'stream'))) {
      if (event.payload?.$case === 'task') streamed = event.payload.value
      if (event.payload?.$case === 'statusUpdate' && event.payload.value.status?.state === TaskState.TASK_STATE_COMPLETED) break
    }
    assert.ok(streamed)
    const fetched = await client.getTask({ tenant: '', id: streamed.id, historyLength: 0 })
    assert.equal(fetched.status.state, TaskState.TASK_STATE_COMPLETED)
    assert.equal(taskOutput(fetched), 'reply:stream:turns=1')

    let heldTaskId
    for await (const event of client.sendMessageStream(message('vertical-hold', 'hold'))) {
      if (event.payload?.$case !== 'task') continue
      heldTaskId = event.payload.value.id
      break
    }
    assert.ok(heldTaskId)
    const canceled = await client.cancelTask({ tenant: '', id: heldTaskId, metadata: undefined })
    assert.equal(canceled.status.state, TaskState.TASK_STATE_CANCELED)

    await world.ctx.fiber.dispose()
    world = await bootWorld(primaryRoot)
    client = await officialClient(world.cardUrl)
    const retained = await client.getTask({ tenant: '', id: first.id, historyLength: 0 })
    assert.equal(taskOutput(retained), 'reply:one:turns=1')
    const resumed = await client.sendMessage(message('vertical-resumed', 'three', first.contextId))
    assert.equal(resumed.contextId, first.contextId)
    assert.equal(taskOutput(resumed), 'reply:three:turns=3')
  } finally {
    await world?.ctx.fiber.dispose()
    await peer?.ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
