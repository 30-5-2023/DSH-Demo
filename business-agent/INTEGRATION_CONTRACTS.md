# 业务 Agent 集成接口

## 接口地图

| 调用方 | 被调用方 | 接口 | 权威数据 |
|---|---|---|---|
| 右侧看板 | 工单服务 | `GET /orders/:id` + SSE | 工单服务快照 |
| 工单服务 | 唤醒器 | `interaction.required` SSE | 交互路由事实 |
| 唤醒器 | DSH Agent | `followup()` / `inject()` | Session 路由 |
| DSH Agent | 工单服务 | 原生 MCP 工具 | 查询与写入结果 |
| 左侧 Client | DSH Session | `prompt(..., "queue")` | 用户提交消息 |

浏览器不通过 MCP 查询工单，也不直接写工单服务。MCP 是 Agent 的工具面；左侧表单来自读取 MCP 的 `structuredContent` 在 Session 日志中的投影。

## 工单快照与事件

快照活动增加可空的 `interactionId`。SSE 仍是刷新信号，右栏看到更大 `rev` 后重读快照。

普通 `activity.changed` 不负责表单唤醒。服务为待处理交互额外发布：

```json
{
  "type": "interaction.required",
  "rev": 4,
  "orderId": "WO-MVP-001",
  "orderTitle": "客户 A 年度授信复核",
  "activityId": "activity-credit-analysis",
  "activitySeq": 2,
  "activityTitle": "生成授信分析报告",
  "interactionId": "interaction-WO-MVP-001-2",
  "reason": "input-required",
  "needsHuman": true,
  "at": "2026-09-22T00:00:00.000Z"
}
```

唤醒器按工单 `rev` 丢弃旧事件，并按 `activityId + interactionId` 去重。事件只携带路由标识；完整字段必须通过 MCP 重读，避免把易丢失的 SSE 当作表单存储。

## Session 绑定与唤醒

成功的顶层工单 MCP 调用使用参数中的 `orderId` 建立或刷新绑定。工具白名单包括：

- `get_order`
- `start_order`
- `start_activity`
- `finish_activity`
- `get_interaction_request`
- `submit_interaction_response`

Agent 空闲时使用 `followup()`，运行中使用 `inject()`；Agent 未加载时保留待投递轮次。普通进度事件只刷新右栏，不进入模型上下文。

`interaction.required` 的模型消息要求立即调用 `mcp__workorder__get_interaction_request`，并把 `orderId` 与 `interactionId` 放在转义后的不可信数据区。唤醒投递只表示消息已进入 Agent 收件箱，不表示模型已经处理或工单已经推进。

## MCP 工具

| 工具 | 入参 | 成功效果 |
|---|---|---|
| `get_order` | `orderId` | 返回 `{ rev, order }` |
| `start_order` | `orderId` | 启动 ready 工单，立即返回 |
| `get_interaction_request` | `orderId`, `interactionId` | 返回版本化 `interaction-request` |
| `submit_interaction_response` | `orderId`, `interactionId`, `expectedOrderRevision`, `idempotencyKey`, `values` | 校验并恢复活动，立即返回 |
| `start_activity` | `orderId`, `seq` | 仅兼容没有交互模板的旧式人工活动 |
| `finish_activity` | `orderId`, `seq` | 仅兼容没有交互模板的旧式人工活动 |

读取工具同时返回文本 `content` 和结构化 `structuredContent`。Host 的 Agent-scoped 工具投影把后者写入顶层 `tool/result.meta`；嵌套工具调用不生成表单元数据。

提交工具以当前服务 `rev` 实现 MVP 乐观并发。生产实现应拆分每单 `orderRevision` 和全局事件游标，持久化幂等结果，并对 `resourceId` 做用户、租户和工单授权校验。

## 表单提交到模型

左侧 toolview 只读取 `tool/result.meta`。用户点击提交后，Client 把以下对象编码进当前 Session 的 UserMessage：

```json
{
  "orderId": "WO-MVP-001",
  "interactionId": "interaction-WO-MVP-001-2",
  "expectedOrderRevision": 4,
  "idempotencyKey": "interaction-WO-MVP-001-2-01",
  "values": {"creditTerm":24}
}
```

UserMessage 明确要求 Agent 调用 `mcp__workorder__submit_interaction_response`。提交先进入 Session，保证模型可见输入能够由日志重放；Client 不调用业务写接口。

## 当前限制

- 工单、交互、幂等结果、绑定和 SSE 游标仍是进程内数据。
- `rev` 仍是服务全局版本，不适合生产多工单冲突检测。
- 资源字段只演示 `resourceId`，尚未接入文件上传和资源授权。
- Client 只保留当前页面生命周期内的已提交状态；服务端始终负责防重复。
- Mock 用模拟 executor 完成交互恢复后的活动，不代表真实 A2A 执行器。

这些限制不改变接口责任：工单服务拥有交互，DSH Agent 使用 MCP，Client 只做结构化展示和 Session 输入。
