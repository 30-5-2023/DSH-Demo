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
        interactionTemplate: {
          reason: 'input-required',
          title: '补充授信分析参数',
          description: '填写分析口径后，Agent 活动将继续生成授信报告。',
          fields: [
            { id: 'creditTerm', type: 'integer', label: '授信期限（月）', required: true, min: 1, max: 120 },
            { id: 'guaranteeType', type: 'select', label: '担保方式', required: true, options: [
              { value: 'none', label: '无担保' },
              { value: 'mortgage', label: '抵押' },
              { value: 'guarantee', label: '保证' },
            ] },
            { id: 'analysisNote', type: 'textarea', label: '补充说明', required: true, placeholder: '请输入需要特别关注的风险或经营变化' },
          ],
        },
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
        interactionTemplate: {
          reason: 'input-required',
          title: '登记人工复核材料',
          description: '补充复核人、日期和已上传的平台资源。',
          fields: [
            { id: 'reviewer', type: 'text', label: '复核人', required: true, placeholder: '请输入姓名' },
            { id: 'reviewDate', type: 'date', label: '复核日期', required: true },
            { id: 'supportingFile', type: 'resource', label: '复核附件', required: true, accept: ['application/pdf', 'text/plain'] },
          ],
        },
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
        interactionTemplate: {
          reason: 'clarification-required',
          title: '确认质检结论',
          description: '选择命中的规则，并确认是否允许带条件通过。',
          fields: [
            { id: 'matchedRules', type: 'multi-select', label: '命中规则', required: true, options: [
              { value: 'ratio', label: '财务比率异常' },
              { value: 'industry', label: '行业集中度偏高' },
              { value: 'document', label: '材料完整性不足' },
            ] },
            { id: 'conditionalPass', type: 'boolean', label: '允许带条件通过', required: true },
            { id: 'qualityComment', type: 'textarea', label: '质检意见', required: true },
          ],
        },
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
        interactionTemplate: {
          reason: 'exception-clarification',
          title: '处理归档异常',
          description: '归档工具发现同名目录，请确认处理方式。',
          fields: [
            { id: 'archiveName', type: 'text', label: '归档名称', required: true, placeholder: '请输入新的归档名称' },
            { id: 'conflictPolicy', type: 'select', label: '冲突处理', required: true, options: [
              { value: 'rename', label: '自动重命名' },
              { value: 'replace', label: '替换旧归档' },
              { value: 'cancel', label: '取消归档' },
            ] },
            { id: 'confirmed', type: 'boolean', label: '已确认以上处理方式', required: true, const: true },
          ],
        },
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
