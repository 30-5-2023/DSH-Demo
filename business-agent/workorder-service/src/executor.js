/**
 * 执行实现：活动**真的怎么跑**。
 *
 * 服务就是业务系统，它自己决定该跑哪一步；「真去跑」这件事落在这一层。
 * demo 里没有真东西可跑，用 `createSimulatedExecutor()` 顶上：等 `stepMs` 就算执行完成，
 * 还能按需注入一次失败。真实实现里换成真的调用（`createService({ executor })`），
 * 执行引擎、三组对外接口、事件载荷一个字节都不用改。
 * @module workorder-service/executor
 */

/** 模拟执行默认的单步时长。真实活动是分钟到小时，demo 用秒级。 */
export const DEFAULT_STEP_MS = 4000

/**
 * 建一个模拟执行实现（demo 用）。
 *
 * 只维护「什么时候把哪个活动交出去的」，到点就报完成——不做任何真实执行。
 * @param options - `stepMs` 单个活动假装要跑多久；`failNextSeq` 让下一次第几号步骤回执失败。
 * @returns 执行实现：`submit` / `poll` / `kind` / `stepMs` / `failNextSeq`。
 */
export function createSimulatedExecutor(options = {}) {
  /** activityId → 提交时刻（毫秒）。 */
  const submitted = new Map()
  const executor = {
    kind: 'simulated',
    /** 单个活动假装要跑多久。`/demo/speed` 会改它。 */
    stepMs: options.stepMs ?? DEFAULT_STEP_MS,
    /** 下一次执行到这个步骤号时回执失败（演示异常路径）。`/demo/fail-next` 会设它。 */
    failNextSeq: options.failNextSeq ?? null,

    /**
     * 把一个活动交给执行实现。
     * @param activity - 活动。
     * @param atMs - 提交时刻。
     */
    submit(activity, atMs) {
      submitted.set(activity.id, atMs)
    },

    /**
     * 问这步跑完没有。引擎每轮心跳问一次。
     * @param activity - 活动。
     * @param atMs - 当前时刻。
     * @param options - `force` 为真时不看时长，直接当做完了（快进与测试用）。
     * @returns 回执：`{status:'done'}` 或 `{status:'failed',failure}`；还在跑时为 `null`。
     */
    poll(activity, atMs, options = {}) {
      const at = submitted.get(activity.id)
      if (at === undefined) return null
      if (options.force !== true && atMs - at < executor.stepMs) return null
      submitted.delete(activity.id)

      if (executor.failNextSeq === activity.seq) {
        executor.failNextSeq = null
        return {
          status: 'failed',
          failure: {
            code: 'UPSTREAM_TIMEOUT',
            message: `步骤 ${String(activity.seq)} 调用下游接口超时（120s），已重试 2 次仍失败`,
          },
        }
      }
      return { status: 'done' }
    },
  }
  return executor
}
