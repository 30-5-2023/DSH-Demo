import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Mock work-order debug labels, confirmations, and action results. */
    businessWorkorderDebug: BusinessWorkorderDebugKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  title: 'Mock 调试',
  environment: 'LOCAL',
  expand: '展开 Mock 调试面板',
  collapse: '收起 Mock 调试面板',
  'order.label': '当前工单',
  'reset.action': '重置工单',
  'reset.working': '正在重置…',
  'reset.success': '工单已恢复为初始状态',
  'reset.failed': '重置失败，请确认 mock 服务已启用调试接口。',
  'reset.confirm': '重置会清除当前 mock 工单的执行进度，确认继续吗？',
  'trace.title': '唤醒链路',
  'trace.empty': '暂无唤醒记录',
  'trace.connection.connecting': '连接中',
  'trace.connection.live': '实时',
  'trace.connection.error': '已断开',
  'trace.step': '步骤 {seq}',
  'trace.trigger': '触发来源',
  'trace.operation': '唤醒器操作',
  'trace.session': '目标会话',
  'trace.agentStatus': 'Agent 状态',
  'trace.event': '工单发送的事件',
  'trace.agentMessage': '发送给 Agent 的消息',
  'trace.noAgentMessage': '未向 Agent 发送消息。',
  'trace.trigger.serviceEvent': '工单活动事件',
  'trace.trigger.bindingChange': '会话绑定更新',
  'trace.trigger.agentAvailable': 'Agent 上线',
  'trace.trigger.humanInput': '收到用户输入',
  'trace.decision.duplicateRevision': '丢弃重复版本',
  'trace.decision.progressOnly': '记录进度，不唤醒',
  'trace.decision.alreadyDelivered': '当前阻塞已投递',
  'trace.decision.waitingForBinding': '保留事件，等待会话绑定',
  'trace.decision.waitingForAgent': '保留事件，等待 Agent 上线',
  'trace.decision.budgetExhausted': '保留事件，唤醒预算已用尽',
  'trace.decision.followup': '调用 followup() 唤醒空闲 Agent',
  'trace.decision.inject': '调用 inject() 注入运行中 Agent',
} satisfies Record<string, string>

/** Debug dictionary key union. */
export type BusinessWorkorderDebugKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  title: 'Mock debug',
  environment: 'LOCAL',
  expand: 'Expand mock debug panel',
  collapse: 'Collapse mock debug panel',
  'order.label': 'Current order',
  'reset.action': 'Reset work order',
  'reset.working': 'Resetting…',
  'reset.success': 'Work order reset to its initial state',
  'reset.failed': 'Reset failed. Check that the mock service debug endpoint is enabled.',
  'reset.confirm': 'Resetting clears the current mock work-order progress. Continue?',
  'trace.title': 'Wake path',
  'trace.empty': 'No wake records',
  'trace.connection.connecting': 'Connecting',
  'trace.connection.live': 'Live',
  'trace.connection.error': 'Disconnected',
  'trace.step': 'Step {seq}',
  'trace.trigger': 'Trigger',
  'trace.operation': 'Wake operation',
  'trace.session': 'Target Session',
  'trace.agentStatus': 'Agent status',
  'trace.event': 'Event sent by the work order',
  'trace.agentMessage': 'Message sent to the Agent',
  'trace.noAgentMessage': 'No message was sent to the Agent.',
  'trace.trigger.serviceEvent': 'Work-order activity event',
  'trace.trigger.bindingChange': 'Session binding update',
  'trace.trigger.agentAvailable': 'Agent became available',
  'trace.trigger.humanInput': 'User input received',
  'trace.decision.duplicateRevision': 'Dropped duplicate revision',
  'trace.decision.progressOnly': 'Recorded progress; no wake',
  'trace.decision.alreadyDelivered': 'Blocking round already delivered',
  'trace.decision.waitingForBinding': 'Retained event; waiting for Session binding',
  'trace.decision.waitingForAgent': 'Retained event; waiting for Agent',
  'trace.decision.budgetExhausted': 'Retained event; wake budget exhausted',
  'trace.decision.followup': 'Called followup() for the idle Agent',
  'trace.decision.inject': 'Called inject() for the running Agent',
} satisfies Record<BusinessWorkorderDebugKey, string>
