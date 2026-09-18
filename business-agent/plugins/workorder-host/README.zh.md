# 业务工单 Host 插件

[English](README.md) | 中文

这个插件把成功的顶层原生工单工具绑定到调用它的 Session，并消费工单 SSE 事件流。它只把新的 `needsHuman` 阻塞轮次投递到已绑定的 live Agent：空闲时使用 `followup()`，运行中使用 `inject()`。每次完成路由判断后，它会发布仅限 Host 内部的 `business-workorder/wake-trace` 观察记录供开发工具使用；观察器失败只记录日志，不会中断消息投递。

## 验证

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-host build
pnpm --filter @deepseek-ai/dsh-business-workorder-host test
```

## 模型体验

官方 MCP Client 暴露原生工单工具。阻塞事件只增加一条插件来源的用户消息，其中经过转义的业务字段会被明确标记为不可信数据；普通进度不进入模型上下文。

## 已知限制

MVP 在内存中保存绑定、事件游标、待投递通知和唤醒预算。重连从实时 SSE 位置开始，因此在加入持久化重放或快照重同步之前，服务中断可能导致事件丢失。
