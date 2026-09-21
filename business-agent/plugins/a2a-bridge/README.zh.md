---
description: "用于通过 A2A Protocol v1.0 暴露 Business Agent，并仅凭 URL 调用其他 A2A agent 的配置与 Agent Card 约定。"
kind: "package-reference"
---

# Business A2A bridge

[English](README.md) | 中文

## 摘要

此包为使用 A2A Protocol v1.0 的 Business Agent 校验网络身份和能力描述。它生成一张 JSON-RPC Agent Card，本地开发默认仅监听回环地址；当 Host 监听所有接口时，它要求显式配置公开 URL 和 Bearer token。它拒绝可能嵌入凭据或形成歧义请求目标的公开 URL 与路由。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

此包目前为 bridge 组合导出 `resolveConfig` 和 `buildAgentCard`。服务器、Session 执行和出站工具完成连接后，Business Agent bundle 将负责 Cordis 挂载。

```yaml
- name: '@deepseek-ai/dsh-business-a2a-bridge'
  config:
    route: /a2a
    publicBaseUrl: http://127.0.0.1:3081
    agent:
      name: Business Agent
      description: Internal business workflow agent
      version: 0.1.0
      defaultInputModes: [text/plain, application/json]
      defaultOutputModes: [text/plain, application/json]
      skills:
        - id: business-workflows
          name: Business Workflows
          description: Handle configured internal business workflows
          tags: [business]
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `route` | `/a2a` | 为 A2A JSON-RPC 保留的绝对非根路径 |
| `publicBaseUrl` | 回环监听 URL | Agent Card 使用的公开 HTTP(S) 基础地址；监听 `0.0.0.0` 时必填 |
| `bearerTokenEnv` | 回环模式不配置 | 保存入站 token 的环境变量；监听 `0.0.0.0` 时必填 |
| `agent` | 必填 | Agent 身份、模式以及至少一项对外声明的 skill |
| 请求与响应限制 | 有界默认值 | 正数的超时、字节数和并发上下文限制 |

运行 `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test` 可验证已实现的配置与 Agent Card 约定。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

配置解析会在挂载任何监听器前校验部署。Card 构建器根据规范化的公开 URL 和路由生成唯一的 A2A JSON-RPC 接口，声明支持流式响应但不支持推送通知，并描述 Bearer 认证而不把密钥复制到发现结果中。环境变量中的 token 只读取一次并保存到解析后的运行时配置。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [A2A bridge 设计](../../../../docs/superpowers/specs/2026-09-20-a2a-bridge-design.md) — 已批准的协议、持久化、生命周期和安全决策
- [Business Agent 设计](../../../DESIGN.md) — 组合方式和业务系统集成模型
- [Subagent 能力决策](../../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md) — 本地与产品进程委派模型

-----

<a id="model-experience"></a>
## 模型体验

无，因为当前包只解析传输元数据，不注册任何模型可见内容。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 当前包只导出配置与 Agent Card 构建；协议路由、基于 Session 的执行、持久化和出站工具尚未连接。
- 每个进程的发现接口只支持一张 Agent Card 和一个 JSON-RPC 接口。
- 出站认证、推送通知、文件、媒体、gRPC 和 HTTP+JSON 不在已批准范围内。

<a id="dev-note"></a>
### 开发说明

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
