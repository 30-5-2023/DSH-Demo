import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Work-order tab labels, connection states, and activity metadata. */
    businessWorkorder: BusinessWorkorderKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'type.label': '工单',
  'guide.title': '当前工单',
  'guide.description': '查看当前业务工单及活动进度',
  'loading.title': '正在读取工单',
  'loading.detail': '正在连接业务服务…',
  'error.title': '工单暂不可用',
  'error.detail': '无法读取业务服务，请检查服务是否已启动。',
  'error.retry': '重新读取',
  'connection.disconnected': '实时连接已断开，当前显示最近一次快照。',
  'connection.live': '实时',
  'order.owner': '负责团队',
  'order.progress': '{done}/{total} 项活动完成',
  'status.ready': '待启动',
  'status.pending': '待执行',
  'status.running': '进行中',
  'status.waiting': '等待处理',
  'status.done': '已完成',
  'activity.automatic': '自动活动',
  'activity.manual': '人工活动',
  'activity.waiting': '需要人工处理',
  'activity.inputs': '输入',
  'activity.outputs': '输出',
  'activity.noOutputs': '尚无输出',
  'activity.current': '当前活动',
  refresh: '刷新工单',
} satisfies Record<string, string>

/** Work-order dictionary key union. */
export type BusinessWorkorderKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  'type.label': 'Work order',
  'guide.title': 'Current work order',
  'guide.description': 'View the current business work order and activity progress',
  'loading.title': 'Loading work order',
  'loading.detail': 'Connecting to the business service…',
  'error.title': 'Work order unavailable',
  'error.detail': 'The business service could not be reached. Check that it is running.',
  'error.retry': 'Try again',
  'connection.disconnected': 'Live updates are disconnected. Showing the latest snapshot.',
  'connection.live': 'Live',
  'order.owner': 'Owner',
  'order.progress': '{done}/{total} activities complete',
  'status.ready': 'Ready',
  'status.pending': 'Pending',
  'status.running': 'Running',
  'status.waiting': 'Waiting',
  'status.done': 'Done',
  'activity.automatic': 'Automatic activity',
  'activity.manual': 'Manual activity',
  'activity.waiting': 'Needs human action',
  'activity.inputs': 'Inputs',
  'activity.outputs': 'Outputs',
  'activity.noOutputs': 'No outputs yet',
  'activity.current': 'Current activity',
  refresh: 'Refresh work order',
} satisfies Record<BusinessWorkorderKey, string>
