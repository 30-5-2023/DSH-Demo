/**
 * 独立服务验证：在**不启动 DSH**的前提下，把三组接口走一遍。
 * 这是 DESIGN.md 里「拿掉 DSH 服务还能不能跑」那条检验的执行版。
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:8090'
const ORDER = 'WO-2026-0916-014'

const health = await (await fetch(`${BASE}/health`)).json()
console.log('健康：', JSON.stringify({ engine: health.engine, executor: health.executor }), '工单数', health.orders)

const list = await (await fetch(`${BASE}/orders`)).json()
console.log('工单列表：', list.orders.map(order => `${order.id}(${order.done}/${order.total})`).join('  '))

const detail = await (await fetch(`${BASE}/orders/${ORDER}`)).json()
console.log('产线：')
for (const activity of detail.order.activities) {
  console.log(
    `  ${String(activity.seq)}. [${activity.typeLabel}/${activity.automation}]`
    + ` ${activity.title.padEnd(10, '　')} ${activity.statusLabel}`
    + (activity.outputs.length > 0 ? `  产出 ${activity.outputs.map(o => o.name).join('、')}` : ''),
  )
}

console.log(`\n订阅事件流 8 秒（模拟执行每 ${String((health.executor.stepMs ?? 4000) / 1000)} 秒算一步跑完，看引擎自己推）：`)
const controller = new AbortController()
setTimeout(() => controller.abort(), 8000)
try {
  const response = await fetch(`${BASE}/events?orderId=${ORDER}`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = block.split('\n').find(line => line.startsWith('data: '))
      if (data !== undefined) {
        const event = JSON.parse(data.slice(6))
        if (event.type === 'activity.changed') {
          console.log(`  [${String(event.activitySeq)}] ${event.from} → ${event.to}  needsHuman=${String(event.needsHuman)}`)
          console.log(`      ${event.line}`)
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
} catch (error) {
  if (error?.name !== 'AbortError') throw error
}
console.log('\n完成：服务在不启动 DSH 的情况下跑通了 HTTP + SSE。')
