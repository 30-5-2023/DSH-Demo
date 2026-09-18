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
        id: 'activity-fetch-customer',
        seq: 1,
        title: '拉取客户主数据',
        type: 'tool',
        automation: 'auto',
        status: 'pending',
        needsHuman: false,
        inputs: [{
          resourceId: 'order-basic-info',
          name: '工单基本信息',
        }],
        outputs: [],
        produces: [{
          resourceId: 'resource-customer-master',
          name: 'customer-master.json',
          kind: 'file',
        }],
        startedAt: null,
        finishedAt: null,
      },
      {
        id: 'activity-credit-analysis',
        seq: 2,
        title: '生成授信分析报告',
        type: 'agent',
        automation: 'auto',
        status: 'pending',
        needsHuman: false,
        inputs: [{
          resourceId: 'resource-customer-master',
          name: 'customer-master.json',
          fromActivitySeq: 1,
        }],
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
        seq: 3,
        title: '复核财报口径',
        type: 'manual',
        automation: 'manual',
        status: 'pending',
        needsHuman: false,
        inputs: [{
          resourceId: 'resource-credit-assessment',
          name: '授信分析报告.md',
          fromActivitySeq: 2,
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
      {
        id: 'activity-compliance-check',
        seq: 4,
        title: '执行授信合规校验',
        type: 'quality',
        automation: 'auto',
        status: 'pending',
        needsHuman: false,
        inputs: [{
          resourceId: 'resource-review-conclusion',
          name: '复核结论.md',
          fromActivitySeq: 3,
        }],
        outputs: [],
        produces: [{
          resourceId: 'resource-compliance-result',
          name: '合规校验结果.json',
          kind: 'file',
        }],
        startedAt: null,
        finishedAt: null,
      },
      {
        id: 'activity-archive-review',
        seq: 5,
        title: '归档授信复核材料',
        type: 'tool',
        automation: 'auto',
        status: 'pending',
        needsHuman: false,
        inputs: [{
          resourceId: 'resource-compliance-result',
          name: '合规校验结果.json',
          fromActivitySeq: 4,
        }],
        outputs: [],
        produces: [{
          resourceId: 'resource-credit-archive',
          name: '授信复核归档包.zip',
          kind: 'file',
        }],
        startedAt: null,
        finishedAt: null,
      },
    ],
  }
}
