/**
 * 示例工单。demo 里代替真实业务系统下发的工单。
 *
 * 形状与 `business-agent/prototype/workorder-pane.html` 里的 mock 数据一致，
 * 方便右栏原型与真实接口对得上。
 * @module workorder-service/seed
 */

const file = (name, fromActivitySeq) => ({
  name,
  kind: 'file',
  ...(fromActivitySeq === undefined ? {} : { fromActivitySeq }),
})

/**
 * 造一份示例工单。
 *
 * 5 个活动：2 个自动、1 个手工、1 个质检、1 个自动收尾。演示时会看到产线
 * 自动走到手工活动就停住等人。
 * @param overrides - 覆盖字段（测试用）。
 * @returns 内部工单对象。
 */
export function seedOrder(overrides = {}) {
  const createdAt = new Date().toISOString()
  const activity = (spec) => ({
    id: `a${String(spec.seq)}`,
    attempts: 0,
    status: 'pending',
    outputs: [],
    startedAt: null,
    finishedAt: null,
    failure: null,
    ...spec,
  })
  return {
    id: 'WO-2026-0916-014',
    title: '客户 A 年度授信复核',
    status: 'running',
    owner: '张三',
    createdAt,
    updatedAt: createdAt,
    currentActivitySeq: 1,
    materials: [
      { name: '授信申请单.pdf', kind: 'file', source: 'workorder' },
      { name: '2025 年报.pdf', kind: 'file', source: 'workorder' },
    ],
    activities: [
      activity({
        seq: 1, type: 'tool', automation: 'auto', title: '拉取客户主数据',
        assignee: 'http.fetchCustomerMaster',
        inputs: [{ name: '工单基本信息', kind: 'record' }],
        produces: [{ name: 'customer-master.json', kind: 'file' }],
      }),
      activity({
        seq: 2, type: 'agent', automation: 'auto', title: '生成授信分析报告',
        assignee: '标准模式 · 本会话',
        inputs: [file('customer-master.json', 1)],
        produces: [file('授信分析报告.md'), { name: '信用评级 AA-', kind: 'text' }],
      }),
      activity({
        seq: 3, type: 'manual', automation: 'manual', title: '复核财报口径',
        assignee: '张三',
        inputs: [file('授信分析报告.md', 2), file('2025 年报.pdf')],
        produces: [file('复核结论.md')],
      }),
      activity({
        seq: 4, type: 'inspection', automation: 'manual', title: '合规终审',
        assignee: '合规岗',
        inputs: [file('授信分析报告.md', 2), file('复核结论.md', 3)],
        produces: [file('合规检查清单.md')],
      }),
      activity({
        seq: 5, type: 'tool', automation: 'auto', title: '归档至影像系统',
        assignee: 'http.archive',
        inputs: [file('授信分析报告.md', 2), file('合规检查清单.md', 4)],
        produces: [file('归档回执.json')],
      }),
    ],
    ...overrides,
  }
}

/**
 * 造第二张工单，用来演示「工单列表里有不止一张」。
 * @returns 内部工单对象。
 */
export function seedSecondOrder() {
  const order = seedOrder({
    id: 'WO-2026-0916-021',
    title: '客户 B 反洗钱复核',
    owner: '李四',
  })
  order.activities = order.activities.map((activity, index) => ({
    ...activity,
    id: `b${String(index + 1)}`,
  }))
  order.activities[0].title = '拉取交易流水'
  order.activities[0].produces = [{ name: 'transactions.json', kind: 'file' }]
  order.activities[1].title = '生成风险评分'
  order.activities[1].inputs = [file('transactions.json', 1)]
  order.activities[1].produces = [{ name: '风险评分.md', kind: 'file' }]
  order.activities[2].title = '复核可疑交易'
  return order
}
