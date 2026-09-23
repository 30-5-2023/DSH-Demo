import { emit } from './domain.js'
import { OperationError, requireOrder } from './operations.js'

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)

function interactionView(state, interaction) {
  return {
    type: 'interaction-request',
    version: '1.0',
    interactionId: interaction.id,
    orderId: interaction.orderId,
    activityId: interaction.activityId,
    status: interaction.status,
    reason: interaction.reason,
    presentation: { type: 'form', title: interaction.title, description: interaction.description },
    fields: interaction.fields.map(field => ({ ...field })),
    submit: { tool: 'submit_interaction_response' },
    orderRevision: state.rev,
  }
}

/** Create the pending interaction owned by one newly waiting activity. */
export function createInteraction(state, order, activity) {
  const template = activity.interactionTemplate
  const id = `interaction-${order.id}-${String(activity.seq)}`
  const interaction = {
    id,
    orderId: order.id,
    activityId: activity.id,
    status: 'pending',
    reason: template.reason,
    title: template.title,
    description: template.description,
    fields: template.fields,
  }
  state.interactions.set(id, interaction)
  activity.interactionId = id
  activity.needsHuman = true
  emit(state, {
    type: 'interaction.required',
    orderId: order.id,
    orderTitle: order.title,
    activityId: activity.id,
    activitySeq: activity.seq,
    activityTitle: activity.title,
    interactionId: id,
    reason: interaction.reason,
    needsHuman: true,
  })
  return interaction
}

/** Read one pending interaction after checking its order ownership. */
export function getInteractionRequest(state, orderId, interactionId) {
  requireOrder(state, orderId)
  const interaction = state.interactions.get(interactionId)
  if (interaction === undefined || interaction.orderId !== orderId) {
    throw new OperationError('interaction-not-found', `交互请求 ${interactionId} 不存在。`)
  }
  return interactionView(state, interaction)
}

function reject(field, message) {
  throw new OperationError('invalid-interaction-values', `字段 ${field.label}：${message}`)
}

function validateValue(field, value) {
  if (value === undefined || value === null || value === '') {
    if (field.required) reject(field, '必填。')
    return
  }
  if (field.type === 'text' || field.type === 'textarea' || field.type === 'date') {
    if (typeof value !== 'string') reject(field, '必须是字符串。')
    return
  }
  if (field.type === 'integer') {
    if (!Number.isSafeInteger(value) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
      reject(field, '必须是允许范围内的整数。')
    }
    return
  }
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean' || (field.const !== undefined && value !== field.const)) reject(field, '值不符合要求。')
    return
  }
  if (field.type === 'select') {
    if (typeof value !== 'string' || !field.options.some(option => option.value === value)) reject(field, '选项无效。')
    return
  }
  if (field.type === 'multi-select') {
    if (!Array.isArray(value) || (field.required && value.length === 0)
      || value.some(item => typeof item !== 'string' || !field.options.some(option => option.value === item))) {
      reject(field, '选项无效。')
    }
    return
  }
  if (field.type === 'resource') {
    if (!isRecord(value) || typeof value.resourceId !== 'string' || value.resourceId.trim() === '') {
      reject(field, '必须引用已上传的平台资源。')
    }
    return
  }
  reject(field, '字段类型不受支持。')
}

/** Validate a response, persist it idempotently, and resume the blocked activity. */
export function submitInteractionResponse(state, request, executor) {
  const fingerprint = JSON.stringify({ orderId: request.orderId, interactionId: request.interactionId, values: request.values })
  const cached = state.interactionSubmissions.get(request.idempotencyKey)
  if (cached !== undefined) {
    if (cached.fingerprint !== fingerprint) {
      throw new OperationError('idempotency-conflict', '幂等键已经用于不同的交互提交。')
    }
    return cached.response
  }
  const order = requireOrder(state, request.orderId)
  const interaction = state.interactions.get(request.interactionId)
  if (interaction === undefined || interaction.orderId !== order.id) {
    throw new OperationError('interaction-not-found', `交互请求 ${request.interactionId} 不存在。`)
  }
  if (interaction.status !== 'pending') throw new OperationError('interaction-already-submitted', '交互请求已经提交。')
  if (request.expectedOrderRevision !== state.rev) {
    throw new OperationError('revision-conflict', `工单版本已从 ${String(request.expectedOrderRevision)} 变为 ${String(state.rev)}，请重新读取。`)
  }
  if (!isRecord(request.values)) throw new OperationError('invalid-interaction-values', 'values 必须是对象。')
  for (const field of interaction.fields) validateValue(field, request.values[field.id])
  const known = new Set(interaction.fields.map(field => field.id))
  if (Object.keys(request.values).some(key => !known.has(key))) {
    throw new OperationError('invalid-interaction-values', 'values 包含未知字段。')
  }
  const activity = order.activities.find(item => item.id === interaction.activityId)
  if (activity?.status !== 'waiting' || activity.interactionId !== interaction.id) {
    throw new OperationError('invalid-activity-state', '交互请求对应的活动不再等待输入。')
  }
  interaction.status = 'submitted'
  interaction.values = structuredClone(request.values)
  activity.status = 'running'
  activity.needsHuman = false
  activity.resumedByInteraction = true
  activity.startedAt = activity.startedAt ?? state.now()
  order.updatedAt = state.now()
  const event = emit(state, {
    type: 'interaction.submitted',
    orderId: order.id,
    orderTitle: order.title,
    activityId: activity.id,
    activitySeq: activity.seq,
    activityTitle: activity.title,
    interactionId: interaction.id,
    needsHuman: false,
  })
  executor.submit(activity)
  const response = { accepted: true, orderId: order.id, interactionId: interaction.id, activityStatus: 'running', rev: event.rev }
  state.interactionSubmissions.set(request.idempotencyKey, { fingerprint, response })
  return response
}
