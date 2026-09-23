import { currentActivity, finishAutomaticActivity } from './operations.js'

/**
 * Poll all running automatic activities once.
 * @param {object} state Service state.
 * @param {object} executor Automatic activity executor.
 * @returns {number} Number of completed automatic activities.
 */
export function tick(state, executor) {
  let completed = 0
  for (const order of state.orders.values()) {
    const activity = currentActivity(order)
    if (order.status !== 'running' || activity?.status !== 'running'
      || (activity.automation !== 'auto' && activity.resumedByInteraction !== true)) continue
    if (!executor.poll(activity)) continue
    finishAutomaticActivity(state, order, activity, executor)
    completed += 1
  }
  return completed
}

/**
 * Start background automatic-activity polling.
 * @param {object} state Service state.
 * @param {object} executor Automatic activity executor.
 * @param {{intervalMs?: number, onError?: (error: unknown) => void}} options Engine options.
 * @returns {() => void} Idempotent stop function.
 */
export function startEngine(state, executor, options = {}) {
  const intervalMs = options.intervalMs ?? 50
  const timer = setInterval(() => {
    try {
      tick(state, executor)
    } catch (error) {
      options.onError?.(error)
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
