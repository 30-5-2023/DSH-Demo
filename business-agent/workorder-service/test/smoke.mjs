/**
 * 冒烟测试：**不启动 DSH**，只用 HTTP 与 MCP 两个公开面把服务跑一遍。
 *
 * 它同时是 0003 那条「拿掉 DSH 服务还能不能独立跑」检验的可执行版本。
 *
 *   node test/smoke.mjs
 * @module workorder-service/test/smoke
 */

import assert from 'node:assert/strict'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createService, createState, MCP_PATH, runUntilBlocked, tick } from '../src/index.js'

const checks = []
/**
 * 跑一个检查并记录结果。
 * @param name - 检查名。
 * @param fn - 检查体。
 */
async function check(name, fn) {
  try {
    await fn()
    checks.push({ name, ok: true })
    process.stdout.write(`  ✓ ${name}\n`)
  } catch (error) {
    checks.push({ name, ok: false, error })
    process.stdout.write(`  ✗ ${name}\n      ${String(error?.message ?? error)}\n`)
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 订阅一条 SSE 流并收集事件。
 *
 * 返回的 promise 在满足 `until` 或超时后 settle，所以调用方可以先拿着它、
 * 再去触发状态变化，最后才 await。
 * @param url - SSE 地址。
 * @param options - `until` 判定、`timeoutMs` 超时。
 * @returns 事件数组的 promise。
 */
async function collectEvents(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000)
  const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } })
  assert.equal(response.status, 200, 'SSE 应返回 200')
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)

  const events = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLine = block.split('\n').find(line => line.startsWith('data: '))
        if (dataLine !== undefined) {
          events.push(JSON.parse(dataLine.slice(6)))
          if (options.until?.(events) === true) return events
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } catch (error) {
    if (error?.name !== 'AbortError') throw error
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
  if (options.until !== undefined && options.until(events) !== true) {
    throw new Error(`等待的事件没到齐，只收到 ${String(events.length)} 条`)
  }
  return events
}

const service = createService({ port: 0, stepMs: 60000, seed: true })
const { url } = await service.listen()
process.stdout.write(`workorder-service 冒烟测试 @ ${url}\n\n`)

const ORDER_A = 'WO-2026-0916-014'
const ORDER_B = 'WO-2026-0916-021'

// MCP 客户端：②③ 两节都要用它调工具，所以先连上，到第三节再断言工具清单。
const client = new Client({ name: 'smoke', version: '0.1.0' }, { capabilities: {} })
await client.connect(new StreamableHTTPClientTransport(new URL(`${url}${MCP_PATH}`)))

/**
 * 调一个工具并把文本结果解析回对象。
 * @param name - 工具名。
 * @param args - 工具参数。
 * @returns 解析后的结果。
 */
async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args })
  const textBlock = result.content.find(block => block.type === 'text')
  return JSON.parse(textBlock.text)
}

process.stdout.write('接口① 读接口（HTTP）\n')
await check('GET /health 报告服务活着', async () => {
  const body = await (await fetch(`${url}/health`)).json()
  assert.equal(body.ok, true)
  assert.equal(body.orders, 2)
})
await check('GET /orders 列出两张示例工单', async () => {
  const body = await (await fetch(`${url}/orders`)).json()
  assert.equal(body.orders.length, 2)
  assert.ok(body.orders.some(order => order.id === ORDER_A))
})
await check('GET /orders/:id 给出整条产线与自动化标记', async () => {
  const body = await (await fetch(`${url}/orders/${ORDER_A}`)).json()
  const activities = body.order.activities
  assert.equal(activities.length, 5)
  assert.deepEqual(activities.map(a => a.automation), ['auto', 'auto', 'manual', 'manual', 'auto'])
  assert.equal(activities[2].inputs[0].fromActivitySeq, 2, '输入应带来源步骤号')
})
await check('PUT /bindings/:clientId 记住谁在看哪张单', async () => {
  await fetch(`${url}/bindings/session-1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: ORDER_A }),
  })
  const body = await (await fetch(`${url}/bindings/session-1`)).json()
  assert.equal(body.orderId, ORDER_A)
})

process.stdout.write('\n接口② 事件流（SSE；看板与唤醒器订的是同一条）\n')
// 先订阅、再触发，否则收不到任何事件。
await check('订阅后能看到步骤状态变化，且载荷主机中立', async () => {
  const collecting = collectEvents(`${url}/events?orderId=${ORDER_A}`, {
    until: list => list.some(event => event.to === 'waiting'),
    timeoutMs: 8000,
  })
  await sleep(250)
  const started = await callTool('start_order', { orderId: ORDER_A, files: ['补充材料.pdf'] })
  assert.equal(started.accepted, true, 'start_order 应立返回')
  assert.equal(started.currentActivitySeq, 3, '自动步骤跑完后应停在第 3 步')
  assert.equal(started.currentActivityStatus, 'waiting', '第 3 步是人工活动，应为 waiting')
  assert.equal(started.needsHuman, true)

  const events = await collecting
  const changes = events.filter(event => event.type === 'activity.changed')
  assert.ok(changes.length >= 2, '至少应收到启动与完成两类变化')
  const first = changes[0]
  assert.equal(first.orderId, ORDER_A)
  assert.equal(typeof first.line, 'string', '应带一行给人看的文案')
  assert.equal(typeof first.needsHuman, 'boolean', 'needsHuman 由服务判定，不由唤醒器算')
  assert.ok(!('sessionId' in first), '载荷里不该出现会话这类主机概念')
  assert.ok(!('message' in first), '载荷里不该出现「写一条消息」这类翻译指令')
  assert.deepEqual(
    changes.filter(event => event.to === 'done').map(event => event.activitySeq),
    [1, 2],
    '前两步应各自广播一次完成',
  )
})

await check('get_order 能看到前两步已完成、第 3 步等待人工', async () => {
  const { order } = await callTool('get_order', { orderId: ORDER_A })
  assert.deepEqual(order.activities.map(a => a.status).slice(0, 4), ['done', 'done', 'waiting', 'pending'])
  assert.ok(order.activities[1].outputs.some(output => output.name === '授信分析报告.md'))
})
await check('start_activity + finish_activity 推进人工步骤', async () => {
  await callTool('start_activity', { orderId: ORDER_A, seq: 3, note: '开始复核' })
  const finished = await callTool('finish_activity', { orderId: ORDER_A, seq: 3, note: '口径一致' })
  assert.equal(finished.status, 'done')
  assert.ok(finished.outputs.includes('复核结论.md'))
})
await check('bind_input 改掉输入绑定并留下决策记录', async () => {
  const result = await callTool('bind_input', {
    orderId: ORDER_A, seq: 5, inputName: '合规检查清单.md', fromSeq: 3, note: '改用复核结论',
  })
  assert.equal(result.input.fromActivitySeq, 3)
  const { decisions } = await (await fetch(`${url}/orders/${ORDER_A}/decisions`)).json()
  assert.ok(decisions.some(decision => decision.action === 'rebind'))
})
await check('decide(reject) 把质检步骤标成异常', async () => {
  const result = await callTool('decide', {
    orderId: ORDER_A, seq: 4, decision: 'reject', note: '合规口径需重新确认',
  })
  assert.equal(result.status, 'failed')
  const { order } = await callTool('get_order', { orderId: ORDER_A })
  assert.equal(order.status, 'blocked')
  assert.equal(order.activities[3].failure.code, 'REJECTED')
})
await check('retry_activity 让失败步骤重跑', async () => {
  await callTool('retry_activity', { orderId: ORDER_A, seq: 4, note: '已补齐材料' })
  const { order } = await callTool('get_order', { orderId: ORDER_A })
  assert.notEqual(order.activities[3].status, 'failed')
})

process.stdout.write('\n引擎自己跑挂时也会进 needsHuman（走另一张单，避免互相影响）\n')
await check('自动活动执行失败时广播 failed 且 needsHuman 为真', async () => {
  await fetch(`${url}/demo/fail-next`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seq: 1 }),
  })
  const collecting = collectEvents(`${url}/events?orderId=${ORDER_B}`, {
    until: list => list.some(event => event.to === 'failed'),
    timeoutMs: 8000,
  })
  await sleep(250)
  await callTool('start_order', { orderId: ORDER_B })
  const failure = (await collecting).find(event => event.to === 'failed')
  assert.equal(failure.needsHuman, true)
  assert.equal(failure.failure.code, 'UPSTREAM_TIMEOUT')
})

process.stdout.write('\n接口③ 工具面（MCP）\n')
await check('tools/list 列出全部工具', async () => {
  const { tools } = await client.listTools()
  const names = tools.map(tool => tool.name)
  for (const expected of ['list_orders', 'get_order', 'start_order', 'start_activity', 'bind_input', 'retry_activity']) {
    assert.ok(names.includes(expected), `缺工具 ${expected}`)
  }
})
await check('server 不返回 instructions（否则会被注入系统提示词）', async () => {
  const info = client.getServerVersion?.()
  assert.ok(info === undefined || info.instructions === undefined)
})

await client.close()
await service.close()

process.stdout.write('\n执行实现可换：引擎留在服务里，换掉的只是「活动交给谁跑」\n')
/** 一个真实执行实现的形状：只回执，不自己计时。 */
function createStubExecutor() {
  const submitted = []
  const receipts = new Map()
  return {
    kind: 'executor',
    submitted,
    submittedAt: () => submitted.map(activity => activity.id),
    submit: (activity) => submitted.push(activity),
    poll: activity => receipts.get(activity.id) ?? null,
    deliver: (activityId, verdict) => receipts.set(activityId, verdict),
  }
}

await check('接上自定义执行实现后，引擎只按回执推进，且 /demo 旋钮回 409', async () => {
  const stub = createStubExecutor()
  const other = createService({ port: 0, seed: true, executor: stub })
  const { url: base } = await other.listen()
  try {
    // 第一轮：第 1 步交出去执行，没有回执，引擎就停在 running 等——不自己判完成。
    runUntilBlocked(other.state, ORDER_A)
    assert.equal(other.state.orders.get(ORDER_A).activities[0].status, 'running')

    // 执行实现回执说第 1 步跑完了：引擎收下回执，顺手把第 2 步交出去。
    stub.deliver('a1', { status: 'done' })
    runUntilBlocked(other.state, ORDER_A)
    const activities = other.state.orders.get(ORDER_A).activities
    assert.equal(activities[0].status, 'done')
    assert.equal(activities[1].status, 'running')
    assert.deepEqual(stub.submittedAt(), ['a1', 'a2'], '交出去的活动按产线顺序，一步一个')

    const rejected = await fetch(`${base}/demo/speed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stepMs: 500 }),
    })
    assert.equal(rejected.status, 409, '演示旋钮长在模拟实现身上，真实实现没有落点')
  } finally {
    await other.close()
  }
})
await check('没接执行实现时引擎直接报错，不静默卡住', () => {
  assert.throws(() => tick(createState()), /executor/)
})

const failed = checks.filter(item => !item.ok)
process.stdout.write(`\n${String(checks.length - failed.length)}/${String(checks.length)} 通过\n`)
if (failed.length > 0) {
  process.stdout.write(`失败：${failed.map(item => item.name).join('、')}\n`)
  process.exitCode = 1
}
