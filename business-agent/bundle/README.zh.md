# 业务 Agent Bundle

[English](README.md) | 中文

这个私有 Bundle 把业务工单 Host、Client 与仅用于开发的调试插件加入以 Web 为基础的 DSH Profile。它的 `cordis.patch.yml` 是业务 Agent 运行时行的组合依据。

## 验证

```sh
pnpm --filter @deepseek-ai/dsh-business-agent build
pnpm --filter @deepseek-ai/dsh-business-agent test
```

MVP Profile 在 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 之后加载这个 Bundle。补丁挂载官方 MCP Client 并连接本地工单服务；服务不可用时启动会明确失败。补丁禁用通用的工作区文件和终端右侧 Sidebar 类型，因此展开右侧 Sidebar 会直接显示工单页。默认收起的悬浮调试卡片可以重置本地 mock 工单并检查唤醒路由，而不在工单页中增加控件。

## 模型体验

Bundle 本身不增加模型可见内容。面向模型的行为由它挂载的插件负责。

## 已知限制

这个 Bundle 是私有包，只供本二次开发工作区使用。
