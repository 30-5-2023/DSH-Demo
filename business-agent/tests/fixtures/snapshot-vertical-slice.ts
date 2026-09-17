import type { Context } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createService, tick } from '@deepseek-ai/dsh-business-workorder-service'
import { OrderId, wakeMessage } from '@deepseek-ai/dsh-business-workorder-host'

/** Snapshot-only composition plugin name. */
export const name = 'business-workorder-vertical-slice-snapshot'

function controlledExecutor(): {
  submit(activity: { id: string }): void
  poll(activity: { id: string }): boolean
  complete(activityId: string): void
} {
  const submitted = new Set<string>()
  const completed = new Set<string>()
  return {
    submit(activity) { submitted.add(activity.id) },
    poll(activity) {
      if (!completed.delete(activity.id)) return false
      return true
    },
    complete(activityId) {
      if (!submitted.has(activityId)) throw new Error(`activity ${activityId} was not submitted`)
      completed.add(activityId)
    },
  }
}

/**
 * Mount the real MCP service and deliver one deterministic production-form waiting notice.
 * @param ctx Snapshot composition context carrying the Tool Runtime.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(async () => {
    const executor = controlledExecutor()
    const service = createService({
      port: 0,
      executor,
      engineIntervalMs: 60_000,
      now: () => '2026-09-18T00:00:00.000Z',
    })
    const { url } = await service.listen()
    let mcpFiber: Awaited<ReturnType<Context['plugin']>> | undefined
    try {
      mcpFiber = await ctx.plugin(McpClient, {
        serverName: 'workorder',
        transport: 'streamable-http',
        url: `${url}/mcp`,
        failOnStartupError: true,
      })
      const stop = ctx.on('tools/result', (execution, result) => {
        if (execution.name !== 'mcp__workorder__start_order' || result.isError) return
        executor.complete('activity-auto-review')
        tick(service.state, executor)
        execution.agent.inject(wakeMessage({
          type: 'activity.changed',
          rev: service.state.rev,
          orderId: OrderId('WO-MVP-001'),
          orderTitle: 'MVP credit review',
          activityId: 'activity-manual-review',
          activitySeq: 2,
          activityTitle: 'Review the credit conclusion',
          from: 'pending',
          to: 'waiting',
          needsHuman: true,
          line: 'Step 2 is waiting for a human reviewer',
        }))
      })
      return async () => {
        stop()
        await mcpFiber?.dispose()
        await service.close()
      }
    } catch (error) {
      await mcpFiber?.dispose()
      await service.close()
      throw error
    }
  }, 'business-workorder-vertical-slice-snapshot: service and MCP')
}
