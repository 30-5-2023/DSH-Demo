import { emit, orderView, progressLine } from './domain.js'
import { seedOrder } from './seed.js'

/** Error returned for rejected business transitions. */
export class OperationError extends Error {
  /**
   * @param {string} code Stable error code.
   * @param {string} message Human-readable explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'OperationError'
    this.code = code
  }
}

/**
 * Require an existing order.
 * @param {object} state Service state.
 * @param {string} orderId Order identifier.
 * @returns {object} Mutable order.
 */
export function requireOrder(state, orderId) {
  const order = state.orders.get(orderId)
  if (order === undefined) throw new OperationError('order-not-found', `工单 ${orderId} 不存在。`)
  return order
}

/**
 * Replace one mock order with its fresh seed state and publish a refresh signal.
 * @param {object} state Service state.
 * @param {string} orderId Order identifier.
 * @returns {object} Reset result and authoritative snapshot.
 */
export function resetOrder(state, orderId) {
  requireOrder(state, orderId)
  const order = seedOrder(state.now)
  if (order.id !== orderId) {
    throw new OperationError('order-not-resettable', `工单 ${orderId} 不是可重置的 mock 工单。`)
  }
  state.orders.set(order.id, order)
  emit(state, {
    type: 'order.reset',
    orderId: order.id,
    orderTitle: order.title,
    needsHuman: false,
  })
  return { accepted: true, orderId, rev: state.rev, order: orderView(order) }
}

/**
 * Return the current activity.
 * @param {object} order Order.
 * @returns {object | undefined} Current activity.
 */
export function currentActivity(order) {
  return order.activities.find(activity => activity.status !== 'done') ?? order.activities.at(-1)
}

/**
 * Emit one activity transition after updating order-level fields.
 * @param {object} state Service state.
 * @param {object} order Order.
 * @param {object} activity Activity.
 * @param {string} status Target status.
 * @returns {object} Published event.
 */
function transition(state, order, activity, status) {
  const from = activity.status
  activity.status = status
  activity.needsHuman = status === 'waiting'
  if (status === 'running') activity.startedAt = activity.startedAt ?? state.now()
  if (status === 'done') {
    activity.finishedAt = state.now()
    activity.outputs = activity.produces.map(output => ({ ...output }))
  }
  order.currentActivitySeq = currentActivity(order)?.seq ?? null
  order.status = order.activities.every(item => item.status === 'done') ? 'done' : 'running'
  order.updatedAt = state.now()
  return emit(state, {
    type: 'activity.changed',
    orderId: order.id,
    orderTitle: order.title,
    activityId: activity.id,
    activitySeq: activity.seq,
    activityTitle: activity.title,
    activityType: activity.type,
    from,
    to: status,
    needsHuman: activity.needsHuman,
    line: progressLine(activity),
    outputs: activity.outputs.map(output => ({ ...output })),
  })
}

/**
 * Activate the current pending activity according to its automation mode.
 * @param {object} state Service state.
 * @param {object} order Order.
 * @param {object} executor Automatic activity executor.
 * @returns {object | undefined} Activated activity, or undefined for a completed order.
 */
function activateCurrentActivity(state, order, executor) {
  if (order.status === 'done') return undefined
  const activity = currentActivity(order)
  if (activity === undefined || activity.status !== 'pending') return activity
  if (activity.automation === 'manual') {
    transition(state, order, activity, 'waiting')
  } else {
    transition(state, order, activity, 'running')
    executor.submit(activity)
  }
  return activity
}

/**
 * Start a ready order and submit its first activity.
 * @param {object} state Service state.
 * @param {string} orderId Order identifier.
 * @param {object} executor Automatic activity executor.
 * @returns {object} Immediate acceptance result.
 */
export function startOrder(state, orderId, executor) {
  const order = requireOrder(state, orderId)
  if (order.status !== 'ready') {
    throw new OperationError('invalid-order-state', `工单 ${orderId} 当前为 ${order.status}，只有 ready 工单可以启动。`)
  }
  order.status = 'running'
  const activity = activateCurrentActivity(state, order, executor)
  return {
    accepted: true,
    orderId,
    rev: state.rev,
    orderStatus: order.status,
    activitySeq: activity.seq,
    activityStatus: activity.status,
  }
}

/**
 * Complete a running automatic activity and activate its successor.
 * @param {object} state Service state.
 * @param {object} order Order.
 * @param {object} activity Automatic activity.
 * @param {object} executor Automatic activity executor.
 */
export function finishAutomaticActivity(state, order, activity, executor) {
  transition(state, order, activity, 'done')
  activateCurrentActivity(state, order, executor)
}

/**
 * Start the current waiting manual activity.
 * @param {object} state Service state.
 * @param {string} orderId Order identifier.
 * @param {number} seq Activity sequence.
 * @returns {object} Immediate acceptance result.
 */
export function startActivity(state, orderId, seq) {
  const order = requireOrder(state, orderId)
  const activity = currentActivity(order)
  if (activity?.seq !== seq || activity.automation !== 'manual' || activity.status !== 'waiting') {
    throw new OperationError('invalid-activity-state', `步骤 ${String(seq)} 不是当前等待中的人工活动。`)
  }
  transition(state, order, activity, 'running')
  return { accepted: true, orderId, rev: state.rev, activitySeq: seq, activityStatus: activity.status }
}

/**
 * Finish the current running manual activity.
 * @param {object} state Service state.
 * @param {string} orderId Order identifier.
 * @param {number} seq Activity sequence.
 * @param {object} executor Automatic activity executor.
 * @returns {object} Immediate acceptance result with the final snapshot.
 */
export function finishActivity(state, orderId, seq, executor) {
  const order = requireOrder(state, orderId)
  const activity = currentActivity(order)
  if (activity?.seq !== seq || activity.automation !== 'manual' || activity.status !== 'running') {
    throw new OperationError('invalid-activity-state', `步骤 ${String(seq)} 不是当前运行中的人工活动。`)
  }
  transition(state, order, activity, 'done')
  activateCurrentActivity(state, order, executor)
  return { accepted: true, orderId, rev: state.rev, activitySeq: seq, activityStatus: activity.status, order: orderView(order) }
}
