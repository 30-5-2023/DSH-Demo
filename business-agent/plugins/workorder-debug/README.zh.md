---
description: "仅用于开发的悬浮控件，用于重置和检查本地 mock 工单服务，且不在正式工单面板中增加操作。"
kind: "package-reference"
---

# 业务工单调试插件

[English](README.md) | 中文

## 摘要

这个插件在 DSH 框架的悬浮层中增加一张默认收起的卡片，用于集中放置 mock 专用操作并检查唤醒链路。调试动作与只读工单页、正式 MCP 写入路径保持分离。卡片可以重置配置的 mock 工单，并展示每次唤醒判断对应的事件、Host 路由决定和发送给 Agent 的精确消息。

## 使用此包

重置功能要求目标服务使用 `--debug` 或 `createService({ debug: true })` 启动。唤醒检查器读取独立的同源 Host 调试流，不依赖 mock 服务的变更端点。

```yaml
- name: '@deepseek-ai/dsh-business-workorder-debug'
  config:
    serviceUrl: http://127.0.0.1:8090
    orderId: WO-MVP-001
    traceLimit: 100
```

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-debug build
pnpm --filter @deepseek-ai/dsh-business-workorder-debug test
```

浏览器在调用 `POST /debug/orders/:orderId/reset` 前要求确认。重置成功后发布带有 `needsHuman: false` 的 `order.reset` 快照刷新信号，不会唤醒 agent。Host 的 `/debug/business-workorder/wake-traces` 流最多保留 `traceLimit` 条观察记录，并区分进度过滤、重复抑制、事件保留、唤醒预算抑制、`followup()` 和 `inject()`。投递记录包含 Agent 实际接收的完整插件用户消息。

## 模型体验

无。这个插件只提供浏览器控件，不增加模型可见输入。

## 已知限制与后续工作

- 此包只面向本地 mock 服务，不是管理接口。
- 卡片只能重置配置的种子工单。
- 服务未以调试模式启动时，调试动作不可用。
- 唤醒观察记录只保存在进程内，DSH Host 重启后清空。
