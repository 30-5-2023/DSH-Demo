# 业务工单 Host 插件

[English](README.md) | 中文

这个插件负责 DSH 会话与工单绑定、业务事件消费及唤醒投递。Task 2 只提供生命周期标记；Task 3 与 Task 4 分别加入原生工具观察和唤醒适配器。

## 验证

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-host build
pnpm --filter @deepseek-ai/dsh-business-workorder-host test
```

## 模型体验

Task 2 标记不增加模型可见内容。Task 4 的唤醒消息是第一项模型可见行为，必须能够从 Session 日志重建。

## 已知限制

MVP 在内存中保存绑定、游标与唤醒预算。重启恢复属于 Task 7。
