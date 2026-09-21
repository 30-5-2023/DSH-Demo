# 业务 Agent Bundle

[English](README.md) | 中文

这个私有 Bundle 把业务工单 Host、Client、仅用于开发的调试插件与 A2A bridge 加入以 Web 为基础的 DSH Profile。它的 `cordis.patch.yml` 是业务 Agent 运行时行的组合依据。

## 验证

```sh
pnpm --filter @deepseek-ai/dsh-business-agent build
pnpm --filter @deepseek-ai/dsh-business-agent test
```

MVP Profile 在 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 之后加载这个 Bundle。补丁挂载官方 MCP Client 并连接本地工单服务；服务不可用时启动会明确失败。补丁禁用通用的工作区文件和终端右侧 Sidebar 类型，因此展开右侧 Sidebar 会直接显示工单页。默认收起的悬浮调试卡片可以重置本地 mock 工单并检查唤醒路由，而不在工单页中增加控件。

补丁还会挂载 `@deepseek-ai/dsh-business-a2a-bridge`。公开 URL 默认取自当前回环监听器，因此用 `-Port 3099` 启动时，无需编辑 Bundle 就会声明 `http://127.0.0.1:3099/a2a`。发现地址仍为 `/.well-known/agent-card.json`；模型通过 `call_a2a_agent` 发起仅凭 URL 的出站调用。

## 模型体验

Bundle 本身不增加模型可见内容。它挂载的 A2A bridge 提供 `call_a2a_agent`，其余面向模型的行为由其他已挂载插件负责。

## 已知限制

这个 Bundle 是私有包，只供本二次开发工作区使用。它的 Web 启动器仅绑定回环地址；如需网络暴露，部署组合必须提供共享 Host 监听器，并遵守 A2A bridge 的公开 URL 与 Bearer token 规则。
