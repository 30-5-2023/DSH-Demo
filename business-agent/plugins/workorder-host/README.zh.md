# 业务工单 Host 插件

[English](README.md) | 中文

这个插件观察成功的顶层原生工单工具，并在进程内保存每个工单的主 Agent 绑定。失败、嵌套和无 Agent 的调用不会建立绑定。

## 验证

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-host build
pnpm --filter @deepseek-ai/dsh-business-workorder-host test
```

## 模型体验

这个插件不增加模型可见内容。原生工单工具仍由官方 MCP Client 提供并暴露。

## 已知限制

MVP 在内存中保存绑定，尚不消费业务事件或投递唤醒消息。
