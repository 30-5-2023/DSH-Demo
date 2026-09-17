/** Stable identifier of the single MVP order. */
export const SEED_ORDER_ID = 'WO-MVP-001'

/**
 * Create the single in-memory MVP order.
 * @param {() => string} [now] Clock used for durable timestamps.
 * @returns {object} A fresh mutable order.
 */
export function seedOrder(now = () => new Date().toISOString()) {
  const createdAt = now()
  return {
    id: SEED_ORDER_ID,
    title: '客户 A 年度授信复核',
    status: 'ready',
    owner: '业务运营组',
    createdAt,
    updatedAt: createdAt,
    currentActivitySeq: 1,
    activities: [
      {
        id: 'activity-auto-review',
        seq: 1,
        title: '自动核验申请材料',
        type: 'tool',
        automation: 'auto',
        status: 'pending',
        needsHuman: false,
        outputs: [],
        produces: [{
          resourceId: 'resource-credit-assessment',
          name: '授信分析报告.md',
          kind: 'file',
        }],
        startedAt: null,
        finishedAt: null,
      },
      {
        id: 'activity-manual-review',
        seq: 2,
        title: '人工复核授信结论',
        type: 'manual',
        automation: 'manual',
        status: 'pending',
        needsHuman: false,
        inputs: [{
          resourceId: 'resource-credit-assessment',
          name: '授信分析报告.md',
          fromActivitySeq: 1,
        }],
        outputs: [],
        produces: [{
          resourceId: 'resource-review-conclusion',
          name: '复核结论.md',
          kind: 'file',
        }],
        startedAt: null,
        finishedAt: null,
      },
    ],
  }
}
