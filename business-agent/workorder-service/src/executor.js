/** Default simulated duration for the automatic MVP activity. */
export const DEFAULT_STEP_MS = 800

/**
 * Create the local simulated automatic-activity executor.
 * @param {{stepMs?: number}} options Executor options.
 * @returns {object} Executor with submit and poll operations.
 */
export function createSimulatedExecutor(options = {}) {
  const submittedAt = new Map()
  const stepMs = options.stepMs ?? DEFAULT_STEP_MS
  return {
    kind: 'simulated',
    stepMs,
    /** @param {object} activity Submitted activity. */
    submit(activity) {
      submittedAt.set(activity.id, Date.now())
    },
    /**
     * @param {object} activity Running activity.
     * @returns {boolean} Whether the activity has completed.
     */
    poll(activity) {
      const submitted = submittedAt.get(activity.id)
      if (submitted === undefined || Date.now() - submitted < stepMs) return false
      submittedAt.delete(activity.id)
      return true
    },
  }
}
