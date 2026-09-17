/**
 * 产线状态机：所有改状态的路径都必须经过这里。
 *
 * 集中在一个文件是为了两件事：每次变化恰好广播一次事件；每次变化恰好追加
 * 一条决策记录。散在各处一定会漏。
 * @module workorder-service/operations
 */

import { appendDecision, emit, needsHuman, progressLine } from './domain.js'

/** 活动结束态：不再参与「当前活动」的判定。 */
const SETTLED = new Set(['done', 'skipped'])

/**
 * 取当前活动：第一个还没结束的活动；全部结束时返回最后一个。
 * @param order - 工单。
 * @returns 当前活动。
 */
export function currentActivity(order) {
  return order.activities.find(activity => !SETTLED.has(activity.status))
    ?? order.activities.at(-1)
}

/**
 * 找活动；找不到就抛，让调用方拿到明确错误而不是静默失败。
 * @param order - 工单。
 * @param seq - 步骤号。
 * @returns 活动。
 * @throws {Error} 步骤号不存在时。
 */
export function requireActivity(order, seq) {
  const activity = order.activities.find(item => item.seq === seq)
  if (activity === undefined) {
    throw new Error(`step ${String(seq)} does not exist on ${order.id}`)
  }
  return activity
}

/**
 * 输入绑定是否就绪：所有带 `fromActivitySeq` 的输入，其前序活动都已完成。
 *
 * 输入是前序输出的绑定而不是产线写死的清单，所以「就绪」是运行时算出来的。
 * @param order - 工单。
 * @param activity - 活动。
 * @returns 就绪时为 true。
 */
export function inputsReady(order, activity) {
  return activity.inputs.every((input) => {
    if (input.fromActivitySeq === undefined) return true
    const previous = order.activities.find(item => item.seq === input.fromActivitySeq)
    return previous !== undefined && previous.status === 'done'
  })
}

/**
 * 一次状态迁移：改活动、算当前活动、记决策、广播。
 *
 * 这是唯一的写入口。引擎与工具都调它，因此事件的顺序与内容不会因调用方而异。
 * 迁进 `running` 时会顺带把活动交给执行实现（见 `state.executor`）。
 * @param state - 状态容器。
 * @param order - 工单。
 * @param activity - 活动。
 * @param to - 目标状态。
 * @param options - 附带字段与决策信息。
 * @returns 迁移后的活动。
 */
export function transition(state, order, activity, to, options = {}) {
  const from = activity.status
  const { outputs, failure, actor = 'pipeline', actorName = null, action = to, reason = null } = options

  Object.assign(activity, { status: to })
  if (outputs !== undefined) activity.outputs = outputs
  if (to === 'running') {
    activity.startedAt = activity.startedAt ?? new Date().toISOString()
    activity.finishedAt = null
    activity.failure = null
    activity.attempts += 1
    // 进入 running 的唯一一处：顺手把活动交给执行实现。放在这里而不是各调用方，
    // 是为了将来多一条推进路径时不会漏交——漏了就是活动永远停在 running。
    state.executor?.submit(activity, Date.now())
  }
  if (to === 'failed') {
    activity.failure = failure ?? { code: 'UNKNOWN', message: '未提供失败原因' }
    activity.finishedAt = new Date().toISOString()
  }
  if (SETTLED.has(to)) {
    activity.failure = null
    activity.finishedAt = new Date().toISOString()
  }

  order.updatedAt = new Date().toISOString()
  order.currentActivitySeq = currentActivity(order).seq
  if (order.activities.every(item => SETTLED.has(item.status))) order.status = 'done'
  else if (order.activities.some(item => item.status === 'failed')) order.status = 'blocked'
  else order.status = 'running'

  appendDecision(state, {
    orderId: order.id,
    actor,
    actorName,
    activityId: activity.id,
    activitySeq: activity.seq,
    action,
    reason,
  })

  emit(state, {
    type: 'activity.changed',
    orderId: order.id,
    orderTitle: order.title,
    activityId: activity.id,
    activitySeq: activity.seq,
    activityTitle: activity.title,
    activityType: activity.type,
    from,
    to: activity.status,
    needsHuman: needsHuman(activity),
    line: progressLine(order, activity),
    outputs: activity.outputs.map(output => output.name),
    failure: activity.failure,
  })
  return activity
}

/**
 * 完成一个活动并落下它的产出。
 * @param state - 状态容器。
 * @param order - 工单。
 * @param activity - 活动。
 * @param options - actor / action / reason。
 * @returns 迁移后的活动。
 */
export function completeActivity(state, order, activity, options = {}) {
  const outputs = (activity.outputs.length > 0 ? activity.outputs : activity.produces ?? [])
    .map(item => ({ ...item, source: 'activity', activitySeq: activity.seq }))
  return transition(state, order, activity, 'done', {
    outputs,
    actor: options.actor ?? 'pipeline',
    action: options.action ?? 'finish',
    reason: options.reason ?? null,
  })
}

/**
 * 启动一个活动。
 * @param state - 状态容器。
 * @param order - 工单。
 * @param activity - 活动。
 * @param options - actor / reason。
 * @returns 迁移后的活动。
 */
export function beginActivity(state, order, activity, options = {}) {
  return transition(state, order, activity, 'running', {
    actor: options.actor ?? 'agent',
    action: options.action ?? 'start',
    reason: options.reason ?? null,
  })
}

/**
 * 标记活动失败。
 * @param state - 状态容器。
 * @param order - 工单。
 * @param activity - 活动。
 * @param failure - 失败原因 `{ code, message }`。
 * @param options - actor / action / reason。
 * @returns 迁移后的活动。
 */
export function failActivity(state, order, activity, failure, options = {}) {
  return transition(state, order, activity, 'failed', {
    failure,
    actor: options.actor ?? 'pipeline',
    action: options.action ?? 'fail',
    reason: options.reason ?? failure?.message ?? null,
  })
}

/**
 * 改一条输入绑定：把某个输入改成取自另一个活动的输出。
 *
 * 绑定可改是异常处置的落点——自动活动跑挂了，人往往要先换输入再重跑。
 * @param state - 状态容器。
 * @param order - 工单。
 * @param activity - 活动。
 * @param inputName - 要改的输入名。
 * @param fromActivitySeq - 新的来源步骤号；`null` 表示改回工单级材料。
 * @param options - reason。
 * @returns 改后的输入。
 */
export function bindInput(state, order, activity, inputName, fromActivitySeq, options = {}) {
  const input = activity.inputs.find(item => item.name === inputName)
  if (input === undefined) {
    throw new Error(`input "${inputName}" does not exist on step ${String(activity.seq)}`)
  }
  if (fromActivitySeq === null) delete input.fromActivitySeq
  else input.fromActivitySeq = fromActivitySeq
  appendDecision(state, {
    orderId: order.id,
    actor: options.actor ?? 'agent',
    activityId: activity.id,
    activitySeq: activity.seq,
    action: 'rebind',
    reason: options.reason ?? `输入「${inputName}」改为取自第 ${String(fromActivitySeq ?? '工单材料')} 步`,
  })
  order.updatedAt = new Date().toISOString()
  emit(state, {
    type: 'activity.changed',
    orderId: order.id,
    activityId: activity.id,
    activitySeq: activity.seq,
    from: activity.status,
    to: activity.status,
    needsHuman: needsHuman(activity),
    line: `✎ 步骤 ${String(activity.seq)}「${activity.title}」的输入「${inputName}」改为取自第 ${String(fromActivitySeq ?? '工单材料')} 步`,
    outputs: activity.outputs.map(output => output.name),
    failure: activity.failure,
  })
  return input
}
