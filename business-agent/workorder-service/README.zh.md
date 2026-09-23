# 业务工单服务

[English](README.md) | 中文

`@deepseek-ai/dsh-business-workorder-service` 是外部业务系统的 MVP mock。它不依赖 DSH，可以独立运行和测试。

## 运行与验证

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-service build
pnpm --filter @deepseek-ai/dsh-business-workorder-service test
pnpm --filter @deepseek-ai/dsh-business-workorder-service start
```

服务默认监听 `127.0.0.1:8090`。测试进程应使用 `--port 0`，由系统分配随机可用端口。

浏览器读取默认允许本地 Web 来源 `http://127.0.0.1:3081` 和 `http://localhost:3081`。`createService({ corsOrigins })` 可以选择其他开发来源；生产认证与来源策略仍留待后续实现。

## MVP 行为

服务预置一张处于 `ready` 状态且包含五个串行活动的工单。第 1 个活动自动运行；第 2 至第 5 个活动分别创建由工单服务拥有的 `interaction-request`，进入 `waiting`，并在 `submit_interaction_response` 接受已校验值后恢复。四次交互分别覆盖 Agent 输入、人工材料、质检确认和工具异常澄清。恢复后的活动由模拟执行器完成；第 5 个活动完成后工单进入 `done`。

模拟执行器默认让每个自动活动运行 800 毫秒，使右侧 Sidebar 中的自动状态变化可被观察；开发环境可以通过 `createService({ stepMs })` 指定其他时长。

包内 `start` 脚本会启用 mock 调试。直接启动时必须传入 `--debug`，程序调用方使用 `createService({ debug: true })`。调试模式提供 `POST /debug/orders/:orderId/reset`，用于替换配置的种子工单、保持服务版本单调递增，并发布不会阻塞流程的 `order.reset` 刷新信号。关闭调试模式后该端点不存在，也不属于生产业务接口。

MVP 状态只存在于当前进程。服务重启后恢复种子状态。持久化与重启恢复属于 Task 7。

## 公开接口

跨模块字段、时序、恢复语义和替换要求见 [业务 Agent 集成接口](../INTEGRATION_CONTRACTS.md)。本节只列出本服务当前开放的入口。

| 接口 | 端点或工具 | 用途 |
|---|---|---|
| HTTP | `GET /health` | 进程健康状态与当前版本 |
| HTTP | `GET /orders/:orderId` | 权威工单快照 |
| SSE | `GET /events?orderId=...` | 作为刷新与唤醒信号的单调递增活动事件 |
| MCP | `POST /mcp` | Streamable HTTP MCP 端点 |
| MCP | `get_order` | 读取工单快照 |
| MCP | `start_order` | 接受异步工单执行请求 |
| MCP | `get_interaction_request` | 读取待处理的结构化交互 |
| MCP | `submit_interaction_response` | 校验字段值并恢复对应活动 |
| MCP | `start_activity` | 启动等待中的人工活动 |
| MCP | `finish_activity` | 完成运行中的人工活动 |

MCP 响应不包含服务端 `instructions`。每个工具都使用 `orderId` 字段，Host 插件据此把成功的顶层工具调用与 DSH 会话关联。

## 事件规则

每次状态变化都会递增服务级 `rev`，并发出一条主机中立事件。`activity.changed` 用于刷新看板；`interaction.required` 携带唤醒器要求 Agent 通过 MCP 读取完整交互所需的标识。事件不包含 DSH 会话或消息指令。消费者使用 `orderId + rev` 去重；发现版本缺口时重新加载 HTTP 快照。

## MVP 限制

- 仅使用内存状态，且只有一张种子工单。
- 仅包含本地开发 CORS，不包含认证或生产来源策略。
- 不包含重试、跳过、重新绑定、失败模拟或交付件下载。
- 不保存会话绑定。DSH 会话与工单的绑定归 Host 插件所有。
- 资源字段只接受已有 `resourceId`；此 mock 不实现上传或资源授权。
