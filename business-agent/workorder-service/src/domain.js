/**
 * 领域模型与内存状态。
 *
 * 这一层刻意不依赖任何框架：工单服务是独立系统，任何人（看板、唤醒器、
 * 测试脚本）都只通过它的接口访问，不通过 import。
 * @module workorder-service/domain
 */

/** 活动类型。与「自动化标记」是两个正交的维度。 */
export const ACTIVITY_TYPES = ['tool', 'agent', 'manual', 'inspection']

/** 活动状态。`waiting` 是关键：轮到它了，但它是人工活动，产线推不动。 */
export const ACTIVITY_STATUSES = ['pending', 'waiting', 'running', 'done', 'failed', 'skipped']

/** 自动化标记：这一步由产线自己跑，还是等人通过对话推进。 */
export const AUTOMATION = ['auto', 'manual']

const nowIso = () => new Date().toISOString()

/**
 * 建一份空的工单状态容器。
 *
 * 事件流与订阅也在这里：服务只有一个进程内状态，所有消费者读的都是它。
 *
 * 不在这里接执行实现（`state.executor`）：那是「活动由谁去跑」的选择，
 * 由 `createService` 显式接上，缺省接内置的模拟实现。
 * @returns 状态容器。
 */
export function createState() {
  return {
    /** 单调递增的修订号。每次状态变化 +1，SSE 消费者用它判断是否落后。 */
    rev: 0,
    /** orderId → 工单。 */
    orders: new Map(),
    /** orderId → 决策记录（时间升序）。 */
    decisions: new Map(),
    /** clientId → orderId。谁在看哪张单。 */
    bindings: new Map(),
    /** 事件订阅者：Set<(event) => void>。 */
    subscribers: new Set(),
    /** 引擎开关（demo 用）。执行实现自己的旋钮在执行实现对象上，不在这里。 */
    engine: { paused: false },
  }
}

/**
 * 广播一条事件给全部订阅者。
 *
 * 订阅者抛错不影响其它订阅者——一个坏掉的浏览器连接不该让服务停摆。
 * @param state - 状态容器。
 * @param event - 要广播的事件载荷。
 */
export function emit(state, event) {
  state.rev += 1
  const frame = { ...event, rev: state.rev, at: event.at ?? nowIso() }
  for (const subscriber of state.subscribers) {
    try {
      subscriber(frame)
    } catch {
      // 单个订阅者失败不影响其它订阅者，也不影响状态本身。
    }
  }
}

/** 活动类型的执行者提示，仅用于示例数据。 */
export const TYPE_LABEL = {
  tool: '工具',
  agent: 'agent',
  manual: '手工',
  inspection: '质检',
}

/** 活动状态的中文标签。前端自己也可以映射，服务提供一份省得两边漂移。 */
export const STATUS_LABEL = {
  pending: '待开始',
  waiting: '等待人工',
  running: '执行中',
  done: '已完成',
  failed: '异常',
  skipped: '已跳过',
}

/**
 * 这个活动此刻是否需要人。
 *
 * 由**服务**判定而不是让每个唤醒器各算一遍：服务知道活动是不是人工活动、
 * 是不是失败了，唤醒器不该重复实现这套判断。
 * @param activity - 活动。
 * @returns 需要人介入时为 true。
 */
export function needsHuman(activity) {
  return activity.status === 'waiting' || activity.status === 'failed'
}

/**
 * 把一个活动投影成给「人」看的一行文字。
 *
 * 主机中立：不提会话、不提消息，只说产线发生了什么。拿它做什么呈现，
 * 是消费者的事。
 * @param order - 所属工单。
 * @param activity - 活动。
 * @returns 一行进度文案。
 */
export function progressLine(order, activity) {
  const outputs = activity.outputs.map(output => output.name).join('、')
  switch (activity.status) {
    case 'running':
      return `▶ 步骤 ${activity.seq}「${activity.title}」已启动`
    case 'done':
      return `✅ 步骤 ${activity.seq}「${activity.title}」已完成${outputs === '' ? '' : `，产出 ${outputs}`}`
    case 'waiting':
      return `⏸ 步骤 ${activity.seq}「${activity.title}」等待人工处理`
    case 'failed':
      return `❌ 步骤 ${activity.seq}「${activity.title}」执行失败`
    case 'skipped':
      return `⏭ 步骤 ${activity.seq}「${activity.title}」已跳过`
    default:
      return `· 步骤 ${activity.seq}「${activity.title}」${STATUS_LABEL[activity.status]}`
  }
}

/**
 * 取工单对外的 JSON 形态。
 *
 * 内部状态里有 Map 与函数，不能直接序列化；这一层保证接口上的形状稳定。
 * @param order - 内部工单对象。
 * @returns 可序列化的工单。
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
    materials: order.materials,
    activities: order.activities.map(activity => ({
      id: activity.id,
      seq: activity.seq,
      type: activity.type,
      typeLabel: TYPE_LABEL[activity.type],
      automation: activity.automation,
      title: activity.title,
      status: activity.status,
      statusLabel: STATUS_LABEL[activity.status],
      needsHuman: needsHuman(activity),
      assignee: activity.assignee,
      inputs: activity.inputs,
      outputs: activity.outputs,
      attempts: activity.attempts,
      startedAt: activity.startedAt,
      finishedAt: activity.finishedAt,
      failure: activity.failure,
    })),
  }
}

/** 工单列表里每一项的精简形态。 */
export function summaryView(order) {
  const current = order.activities.find(activity => activity.seq === order.currentActivitySeq)
  return {
    id: order.id,
    title: order.title,
    status: order.status,
    owner: order.owner,
    total: order.activities.length,
    done: order.activities.filter(activity => activity.status === 'done').length,
    currentActivity: current === undefined
      ? null
      : { seq: current.seq, title: current.title, status: current.status, needsHuman: needsHuman(current) },
  }
}

/**
 * 追加一条决策记录。
 *
 * 决策记录是审计口径，只记真实发生的事；「我们投递了一条消息」不算。
 * @param state - 状态容器。
 * @param entry - 记录内容，缺省字段由本函数补齐。
 * @returns 落库后的记录。
 */
export function appendDecision(state, entry) {
  const decision = {
    id: `d-${String(state.rev)}-${String(Math.random()).slice(2, 8)}`,
    at: entry.at ?? nowIso(),
    actor: entry.actor,
    actorName: entry.actorName ?? null,
    activityId: entry.activityId ?? null,
    activitySeq: entry.activitySeq ?? null,
    action: entry.action,
    reason: entry.reason ?? null,
  }
  const list = state.decisions.get(entry.orderId) ?? []
  list.push(decision)
  state.decisions.set(entry.orderId, list)
  return decision
}
