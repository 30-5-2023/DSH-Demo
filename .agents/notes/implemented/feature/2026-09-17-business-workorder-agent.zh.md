# Agent Note: 业务工单 Agent

Status: implemented

[English](2026-09-17-business-workorder-agent.md) | 中文

## Problem

业务工作流需要持久的执行权威、只读的运行视图，以及只在执行阻塞时请求人工决策的 agent。把三项职责都放进对话运行时，会让业务状态绑定到一个 agent 宿主，让普通进度消耗模型上下文，并在 DeepSeek Harness 内形成第二个业务状态权威。

## Decision

工单服务独立于 DSH。服务拥有工单状态、状态迁移、HTTP 快照、SSE 通知和 MCP 工具。DSH Host 插件拥有内存中的会话与工单绑定、事件游标、唤醒预算和消息投递。业务 UI 插件注册只读右侧 Sidebar 标签页，通过 Host 页面注入取得经过校验的 `serviceUrl` 和一个 MVP `orderId`，并直接从服务读取业务快照和 SSE。业务 Bundle 禁用通用的工作区文件和终端标签页类型，使工单入口成为右侧 Sidebar 展开时的默认页面。独立的开发插件注册默认收起的悬浮卡片，用于集中放置 mock 专用控件；重置动作调用显式启用的 `/debug` 端点，不进入生产 MCP 工具集。同一插件从 Host 接收有界、仅存于进程内的唤醒观察记录，并通过同源调试流展示服务事件、路由决定和实际投递给 Agent 的完整消息。

左侧对话继续使用现有 DSH 界面。agent 只通过原生 MCP 工具改变业务状态。普通进度不进入模型上下文。只有携带 `needsHuman: true` 的服务事件才能唤醒 agent；空闲 agent 接收 `followup()`，运行中的 agent 接收供下一步骤使用的 `inject()`。

一张工单只有一个主会话，一个会话可以绑定多张工单。MVP 中右侧 Sidebar 跟随会话最近活动的工单。工单初始状态为 `ready`，`start_order` 执行 `ready -> running`。种子产线先运行两个自动活动，第 3 个活动分别通过 `start_activity` 和 `finish_activity` 处理人工等待，然后再运行两个自动活动并完成。交付件使用不透明的 `resourceId`。唤醒预算按会话和工单计算，连续主动唤醒三次，只有真人输入重置。

实现以 Cordis 插件、Bundle 和 Profile patch 的形式保存在 `business-agent/` 下，不修改 `packages/`、`apps/` 或 agent loop。一个确定性的无密钥场景通过回放模型输出、官方 MCP Client、串行异步执行、SSE 刷新、第 3 步的一次人工唤醒、恢复自动执行，最终让五个活动到达右侧 Sidebar 完成状态。持久化、恢复、安全、交付件读取和按会话选择多工单仍属于后续增量。

## Alternatives considered

**把会话绑定保存在业务服务中。** 不采用，因为业务服务将需要认识 agent 宿主身份，并重复保存 Host 持有的路由状态。

**把进度写入对话。** 不采用，因为普通执行会消耗模型上下文，陈旧进度可能被误认为当前权威状态。agent 只在需要决策时查询当前工单。

**在右侧 Sidebar 增加写控件。** 不采用，因为第二个写入口会把授权和审计行为分散到 UI 与 MCP 工具中。

**修改 DSH agent loop。** 不采用，因为 Cordis 事件、原生 MCP 工具、右侧 Sidebar slot 和 Agent 消息 API 已经提供所需扩展点。

## Verification

- 服务包在不依赖 DSH 的情况下验证 HTTP、SSE、MCP、异步执行、非法迁移、确定性时间与 CORS 行为。
- Host 测试验证原生工具绑定、空闲与运行中投递、重放去重、唤醒预算、不可信文本、重连和卸载清理。
- Client 工件测试验证 Host 注入配置和构建后的浏览器闭包。
- 调试插件工件和浏览器场景验证显式启用的重置、确认、SSE 刷新、重置不会唤醒 Agent、进度过滤以及精确的 `inject()` 投递记录；Host 单元覆盖验证空闲 Agent 的 `followup()` 观察记录。
- 无密钥 Session 快照和 built-Web 场景跨真实 DSH 页面、官方 MCP Client、服务、唤醒适配器和直接打开的右侧 Sidebar 工单页完成一张工单。

## Consequences

服务和 Host 把状态保存在内存中，因此在持久化增量完成前，进程重启会丢失进度或路由。浏览器直读需要开发环境 CORS 放行，部署认证与来源限制将在后续完成。右侧 Sidebar 展示 Host 配置的 MVP 工单，而不是从当前 Session 绑定推导工单。绑定依赖原生工具，因此在显式绑定机制实现前不支持仅使用 PTC 的展示模式。无密钥场景验证的是确定性回放，不是真实模型提供方。
