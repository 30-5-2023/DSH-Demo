# 业务 Agent Bundle

[English](README.md) | 中文

这个私有 Bundle 把业务工单 Host、Client、仅用于开发的调试插件与 A2A bridge 加入以 Web 为基础的 DSH Profile。它的 `cordis.patch.yml` 是业务 Agent 运行时行的组合依据。

## 验证

```sh
pnpm --filter @deepseek-ai/dsh-business-agent build
pnpm --filter @deepseek-ai/dsh-business-agent test
```

MVP Profile 在 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 之后加载这个 Bundle。补丁挂载官方 MCP Client 并连接本地工单服务；服务不可用时启动会明确失败。补丁禁用通用的工作区文件和终端右侧 Sidebar 类型，因此展开右侧 Sidebar 会直接显示工单页。默认收起的悬浮调试卡片可以重置本地 mock 工单并检查唤醒路由，而不在工单页中增加控件。

补丁还会挂载 `@deepseek-ai/dsh-business-a2a-bridge`。Web 监听器保持在 `127.0.0.1:3081`，A2A 专用监听器默认使用 `127.0.0.1:3082`。`A2A_LISTEN_HOST`、`A2A_LISTEN_PORT` 和 `A2A_PUBLIC_BASE_URL` 在运行时提供部署值，因此镜像中不包含主机或容器 IP。发现地址仍为 `/.well-known/agent-card.json`；模型通过 `call_a2a_agent` 发起仅凭 URL 的 v1.0 或 v0.3 调用。

## 模型体验

Bundle 本身不增加模型可见内容。它挂载的 A2A bridge 提供 `call_a2a_agent`，其余面向模型的行为由其他已挂载插件负责。

## 已知限制

这个 Bundle 是私有包，只供本二次开发工作区使用。它的 Web 启动器仅绑定回环地址。直接向内网暴露时，应让 A2A 专用监听器绑定 `0.0.0.0` 并提供可达的公开 URL；预研部署可不启用认证。
