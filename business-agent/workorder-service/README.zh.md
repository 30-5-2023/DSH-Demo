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

## MVP 行为

服务预置一张处于 `ready` 状态的工单。`start_order` 只接受 `ready -> running`，并在自动活动完成前返回。执行引擎在后台推进该活动，然后停在一个 `needsHuman: true` 的人工活动。`start_activity` 与 `finish_activity` 是两个独立操作。完成人工活动后，工单随即完成。

MVP 状态只存在于当前进程。服务重启后恢复种子状态。持久化与重启恢复属于 Task 7。

## 公开接口

| 接口 | 端点或工具 | 用途 |
|---|---|---|
| HTTP | `GET /health` | 进程健康状态与当前版本 |
| HTTP | `GET /orders/:orderId` | 权威工单快照 |
| SSE | `GET /events?orderId=...` | 作为刷新与唤醒信号的单调递增活动事件 |
| MCP | `POST /mcp` | Streamable HTTP MCP 端点 |
| MCP | `get_order` | 读取工单快照 |
| MCP | `start_order` | 接受异步工单执行请求 |
| MCP | `start_activity` | 启动等待中的人工活动 |
| MCP | `finish_activity` | 完成运行中的人工活动 |

MCP 响应不包含服务端 `instructions`。每个工具都使用 `orderId` 字段，Host 插件据此把成功的顶层工具调用与 DSH 会话关联。

## 事件规则

每次状态变化都会递增服务级 `rev`，并发出一条主机中立事件。事件描述工单与活动，包含 `needsHuman`，但不包含 DSH 会话或消息指令。消费者使用 `orderId + rev` 去重；发现版本缺口时重新加载 HTTP 快照。

## MVP 限制

- 仅使用内存状态，且只有一张种子工单。
- 不包含认证或生产 CORS 策略。
- 不包含重试、跳过、重新绑定、失败模拟或交付件下载。
- 不保存会话绑定。DSH 会话与工单的绑定归 Host 插件所有。
