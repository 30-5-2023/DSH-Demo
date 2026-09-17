/**
 * 接口③工具面：给 agent 的 MCP 工具。
 *
 * 形状照抄 DSH 自己的 MCP 测试夹具（`packages/mcp/mcp-client/tests/http-fixture.ts`）：
 * `createMcpHandler` + `toNodeHandler`，无状态、每个请求造一个 McpServer，
 * 共享同一个进程内状态。
 *
 * 两条约定必须守住：
 *  1. **所有工具立返回**——「启动工单」返回「已提交」，不等到跑完。
 *  2. **工单号字段叫 `orderId`**——唤醒器要从工具调用参数里读它记「会话 ↔ 工单」绑定。
 * @module workorder-service/mcp
 */

import { z } from 'zod'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { orderView, summaryView } from './domain.js'
import {
  beginActivity, bindInput, completeActivity, currentActivity, failActivity,
  requireActivity, transition,
} from './operations.js'
import { runUntilBlocked } from './engine.js'

/** 把内部对象包成 MCP 的文本结果。 */
const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})

/** 工单不存在时抛一个模型看得懂的错误。 */
function requireOrder(state, orderId) {
  const order = state.orders.get(orderId)
  if (order === undefined) {
    throw new Error(`工单 ${orderId} 不存在。先用 list_orders 确认工单号。`)
  }
  return order
}

/**
 * 建一个绑定了当前状态的 MCP server。
 *
 * 无状态：每个请求新建，避免会话恢复、并发调用之间互相影响。
 * @param state - 状态容器。
 * @returns MCP server。
 */
export function createServer(state) {
  const mcp = new McpServer(
    { name: 'workorder', version: '0.1.0' },
    // 不返回 instructions：DSH 会把 instructions 自动注入系统提示词，
    // 而产线状态会变，不适合做成常驻上下文。
    { capabilities: { tools: {} } },
  )

  mcp.registerTool('list_orders', {
    description: '列出工单。返回工单号、标题、状态与当前进行到第几步。',
    inputSchema: z.object({
      status: z.string().optional().describe('按状态过滤：running / blocked / done'),
      q: z.string().optional().describe('标题关键词'),
    }),
  }, async ({ status, q }) => text({
    orders: [...state.orders.values()]
      .filter(order => status === undefined || order.status === status)
      .filter(order => q === undefined || order.title.includes(q))
      .map(summaryView),
  }))

  mcp.registerTool('get_order', {
    description: '读一张工单的完整产线：每一步的类型、自动化标记、状态、输入绑定、产出与失败原因。推进产线之前先调它确认当前步骤。',
    inputSchema: z.object({ orderId: z.string().describe('工单号') }),
  }, async ({ orderId }) => text({ order: orderView(requireOrder(state, orderId)) }))

  mcp.registerTool('start_order', {
    description: '启动一张工单的产线。立即返回，不等待执行完成；后续进度通过事件流推送。',
    inputSchema: z.object({
      orderId: z.string().describe('工单号'),
      files: z.array(z.string()).optional().describe('输入文件名'),
    }),
  }, async ({ orderId, files }) => {
    const order = requireOrder(state, orderId)
    if (files !== undefined && files.length > 0) {
      order.materials = [
        ...order.materials,
        ...files.filter(name => !order.materials.some(item => item.name === name))
          .map(name => ({ name, kind: 'file', source: 'upload' })),
      ]
    }
    order.status = 'running'
    // 立返回：把自动活动推到下一个需要人的地方就交还给调用方。
    runUntilBlocked(state, orderId)
    const activity = currentActivity(order)
    return text({
      accepted: true,
      orderId,
      currentActivitySeq: activity?.seq ?? null,
      currentActivityStatus: activity?.status ?? null,
      needsHuman: activity?.status === 'waiting' || activity?.status === 'failed',
    })
  })

  mcp.registerTool('start_activity', {
    description: '把某一步推进到执行中（人工步骤由人下达后调它）。立即返回。',
    inputSchema: z.object({
      orderId: z.string(),
      seq: z.number().int().describe('步骤号'),
      note: z.string().optional().describe('说明，会进决策记录'),
    }),
  }, async ({ orderId, seq, note }) => {
    const order = requireOrder(state, orderId)
    const activity = requireActivity(order, seq)
    beginActivity(state, order, activity, { actor: 'agent', reason: note ?? null })
    return text({ accepted: true, step: seq, status: activity.status })
  })

  mcp.registerTool('finish_activity', {
    description: '把某一步标记为完成并落下产出。立即返回。',
    inputSchema: z.object({
      orderId: z.string(),
      seq: z.number().int(),
      note: z.string().optional(),
    }),
  }, async ({ orderId, seq, note }) => {
    const order = requireOrder(state, orderId)
    const activity = requireActivity(order, seq)
    completeActivity(state, order, activity, { actor: 'agent', reason: note ?? null })
    return text({ accepted: true, step: seq, status: activity.status, outputs: activity.outputs.map(o => o.name) })
  })

  mcp.registerTool('decide', {
    description: '给出质检结论。approve 通过并完成该步；reject 驳回并把该步标为异常。立即返回。',
    inputSchema: z.object({
      orderId: z.string(),
      seq: z.number().int(),
      decision: z.enum(['approve', 'reject']),
      note: z.string().optional().describe('结论说明'),
    }),
  }, async ({ orderId, seq, decision, note }) => {
    const order = requireOrder(state, orderId)
    const activity = requireActivity(order, seq)
    if (decision === 'reject') {
      failActivity(state, order, activity, {
        code: 'REJECTED', message: note ?? '质检驳回',
      }, { actor: 'agent', action: 'reject', reason: note ?? null })
    } else {
      completeActivity(state, order, activity, { actor: 'agent', action: 'approve', reason: note ?? null })
    }
    return text({ accepted: true, step: seq, status: activity.status })
  })

  mcp.registerTool('fail_activity', {
    description: '把人判定为异常的一步标为失败，等后续处置。立即返回。',
    inputSchema: z.object({
      orderId: z.string(),
      seq: z.number().int(),
      message: z.string().describe('失败原因'),
    }),
  }, async ({ orderId, seq, message }) => {
    const order = requireOrder(state, orderId)
    const activity = requireActivity(order, seq)
    failActivity(state, order, activity, { code: 'MANUAL_HOLD', message }, { actor: 'agent' })
    return text({ accepted: true, step: seq, status: activity.status })
  })

  mcp.registerTool('bind_input', {
    description: '改一条输入绑定：把某一步的某个输入改成取自另一步的输出。异常处置时常要先改输入再重跑。立即返回。',
    inputSchema: z.object({
      orderId: z.string(),
      seq: z.number().int().describe('要改输入的那一步'),
      inputName: z.string().describe('输入件名'),
      fromSeq: z.number().int().nullable().describe('新的来源步骤号；null 表示改回工单材料'),
      note: z.string().optional(),
    }),
  }, async ({ orderId, seq, inputName, fromSeq, note }) => {
    const order = requireOrder(state, orderId)
    const activity = requireActivity(order, seq)
    const input = bindInput(state, order, activity, inputName, fromSeq, { reason: note ?? null })
    return text({ accepted: true, step: seq, input })
  })

  mcp.registerTool('retry_activity', {
    description: '重跑一个失败的步骤（从头再来）。立即返回。',
    inputSchema: z.object({
      orderId: z.string(),
      seq: z.number().int(),
      note: z.string().optional(),
    }),
  }, async ({ orderId, seq, note }) => {
    const order = requireOrder(state, orderId)
    const activity = requireActivity(order, seq)
    beginActivity(state, order, activity, { actor: 'agent', action: 'retry', reason: note ?? null })
    runUntilBlocked(state, orderId)
    return text({ accepted: true, step: seq, status: activity.status })
  })

  mcp.registerTool('skip_activity', {
    description: '跳过某一步。立即返回。',
    inputSchema: z.object({
      orderId: z.string(),
      seq: z.number().int(),
      reason: z.string().describe('跳过原因，会进决策记录'),
    }),
  }, async ({ orderId, seq, reason }) => {
    const order = requireOrder(state, orderId)
    const activity = requireActivity(order, seq)
    transition(state, order, activity, 'skipped', { actor: 'agent', action: 'skip', reason })
    runUntilBlocked(state, orderId)
    return text({ accepted: true, step: seq, status: activity.status })
  })

  return mcp
}

/**
 * 造 MCP 的 Node 请求处理器。
 * @param state - 状态容器。
 * @returns `(req, res) => Promise<void>`，内部自行判断路径。
 */
export function createMcpNodeHandler(state) {
  return toNodeHandler(createMcpHandler(() => createServer(state)))
}
