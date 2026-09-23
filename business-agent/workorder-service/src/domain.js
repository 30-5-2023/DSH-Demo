/**
 * Create an empty in-memory service state.
 * @param {{now?: () => string}} options State dependencies.
 * @returns {object} Service state.
 */
export function createState(options = {}) {
  return {
    rev: 0,
    now: options.now ?? (() => new Date().toISOString()),
    orders: new Map(),
    interactions: new Map(),
    interactionSubmissions: new Map(),
    subscribers: new Set(),
    eventStreams: new Set(),
  }
}

/**
 * Publish one state-change event with the next monotonic revision.
 * @param {object} state Service state.
 * @param {object} event Event fields without revision and timestamp.
 * @returns {object} Published event.
 */
export function emit(state, event) {
  state.rev += 1
  const frame = { ...event, rev: state.rev, at: state.now() }
  for (const subscriber of state.subscribers) {
    try {
      subscriber(frame)
    } catch (error) {
      // A disconnected consumer must not block state progression.
      void error
    }
  }
  return frame
}

/**
 * Project mutable service state into the public order representation.
 * @param {object} order Internal order.
 * @returns {object} Serializable order snapshot.
 */
export function orderView(order) {
  return {
    id: order.id,
    title: order.title,
    status: order.status,
    owner: order.owner,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    currentActivitySeq: order.currentActivitySeq,
    activities: order.activities.map(activity => ({
      id: activity.id,
      seq: activity.seq,
      title: activity.title,
      type: activity.type,
      automation: activity.automation,
      status: activity.status,
      needsHuman: activity.needsHuman,
      interactionId: activity.interactionId ?? null,
      inputs: activity.inputs ?? [],
      outputs: activity.outputs,
      startedAt: activity.startedAt,
      finishedAt: activity.finishedAt,
    })),
  }
}

/**
 * Return a stable host-neutral description for an activity state.
 * @param {object} activity Activity.
 * @returns {string} Human-readable progress line.
 */
export function progressLine(activity) {
  if (activity.status === 'running') return `步骤 ${String(activity.seq)}「${activity.title}」已启动`
  if (activity.status === 'waiting') return `步骤 ${String(activity.seq)}「${activity.title}」等待人工处理`
  if (activity.status === 'done') return `步骤 ${String(activity.seq)}「${activity.title}」已完成`
  return `步骤 ${String(activity.seq)}「${activity.title}」状态为 ${activity.status}`
}
