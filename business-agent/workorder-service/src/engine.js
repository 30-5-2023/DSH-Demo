/**
 * 执行引擎：消费执行实现回执，把产线往下推。
 *
 * **这个模块是服务自己的，不是 demo 的脚手架。** 服务就是业务系统，它认产线结构、
 * 判输入是否就绪、推状态机、决定什么时候该喊人。它换不掉。
 *
 * 换得掉的是**执行实现**（`state.executor`）：活动真的怎么跑是它的事，引擎只把活动
 * 交出去、听回执。demo 缺省接的是模拟实现，见 executor.js。
 *
 * 规则：输入齐了的自动活动交出去执行；人工活动走到就停住等人；回执说失败也停住等人。
 * @module workorder-service/engine
 */

import { needsHuman } from './domain.js'
import {
  beginActivity, completeActivity, currentActivity, failActivity, inputsReady, transition,
} from './operations.js'

/**
 * 推进一轮。
 *
 * 幂等且可重入：引擎定时器与工具调用都会触发它，处理同一个状态不会重复迁移。
 * @param state - 状态容器（必须已经接上 `state.executor`）。
 * @param options - `orderId` 只推进这张工单；`force` 为真时不看执行时长，直接收下回执。
 * @returns 本轮发生迁移的活动步骤号列表。
 */
export function tick(state, options = {}) {
  const executor = state.executor
  if (executor === undefined) {
    throw new Error('state.executor 没接：引擎不知道活动该交给谁执行（createService 会接上）')
  }

  const changed = []
  const nowMs = Date.now()
  const orders = options.orderId === undefined
    ? [...state.orders.values()]
    : [state.orders.get(options.orderId)].filter(order => order !== undefined)
  for (const order of orders) {
    const activity = currentActivity(order)
    if (activity === undefined) continue

    if (activity.status === 'pending') {
      if (!inputsReady(order, activity)) continue
      if (activity.automation === 'auto') {
        // 交出去执行；beginActivity 里的 transition 顺手就 submit 了。
        beginActivity(state, order, activity, { actor: 'pipeline', action: 'start', reason: '输入已就绪' })
      } else {
        // 人工活动：产线推不动，转「等待人工」并喊人。这是 needsHuman 的第一个来源。
        transition(state, order, activity, 'waiting', {
          actor: 'pipeline', action: 'wait', reason: '需要人工处理',
        })
      }
      changed.push(activity.seq)
      continue
    }

    if (activity.status === 'running') {
      const verdict = executor.poll(activity, nowMs, { force: options.force === true })
      if (verdict === null) continue

      if (verdict.status === 'failed') {
        // 失败原因来自执行实现，不由引擎编：真实实现里它就是执行侧报回来的错。
        failActivity(state, order, activity, verdict.failure)
      } else {
        completeActivity(state, order, activity, { actor: 'pipeline', action: 'finish' })
      }
      changed.push(activity.seq)
      continue
    }

    // waiting / failed：产线不推进，等人在对话里下指令。这正是「卡住」的样子。
    // 进入这两个状态的瞬间已经由 transition 广播过事件，这里不再重复发。
  }
  return changed
}

/**
 * 启动定时引擎。
 *
 * 每次心跳推一轮：把该执行的活动交出去、把已回来的回执落进状态机。
 * @param state - 状态容器。
 * @param options - `intervalMs` 心跳间隔。
 * @returns 停止函数。
 */
export function startEngine(state, options = {}) {
  const intervalMs = options.intervalMs ?? 1000
  const timer = setInterval(() => {
    if (state.engine.paused) return
    try {
      tick(state)
    } catch (error) {
      // 引擎的单轮失败不应拖垮服务进程；记下来继续跑。
      console.error('[workorder-service] engine tick failed:', error)
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * 快进：把某张工单的自动活动一路跑到下一个需要人的地方。
 *
 * 给演示与冒烟测试用——不用真等执行实现的回执。
 * @param state - 状态容器。
 * @param orderId - 只推进这张工单；缺省推进全部。
 * @param maxRounds - 上限，防止死循环。
 * @returns 经过的轮数。
 */
export function runUntilBlocked(state, orderId, maxRounds = 50) {
  const scope = typeof orderId === 'string' ? { orderId } : {}
  let rounds = 0
  while (rounds < maxRounds) {
    rounds += 1
    const progress = tick(state, { ...scope, force: true })
    if (progress.length === 0) break
    const orders = scope.orderId === undefined
      ? [...state.orders.values()]
      : [state.orders.get(scope.orderId)].filter(order => order !== undefined)
    const blocked = orders.some((order) => {
      const activity = currentActivity(order)
      return activity !== undefined && needsHuman(activity)
    })
    if (blocked) break
  }
  return rounds
}
