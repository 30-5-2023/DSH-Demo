---
description: "用于通过 A2A Protocol v1.0 暴露 Business Agent，并仅凭 URL 调用其他 A2A agent 的配置与 Agent Card 约定。"
kind: "package-reference"
---

# Business A2A bridge

[English](README.md) | 中文

## 摘要

此包通过 A2A Protocol v1.0 暴露 Business Agent，并让该 agent 通过对方的 Agent Card URL 调用其他 A2A agent。它在共享 Host 监听器上挂载发现与 JSON-RPC 路由，通过普通持久化 Session 执行入站工作，并注册模型可见的 `call_a2a_agent` 工具。本地开发默认使用回环地址；监听所有接口时必须显式配置公开 URL 和入站 Bearer token。

## 目录

- [使用此包](#use-this-package)
- [运行两个本地 agent](#operate-two-local-agents)
- [暴露内网监听器](#expose-an-intranet-listener)
- [运行限制](#operating-limits)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 `dsh` profile 中加载此插件。使用下方示例时，发现地址为 `http://127.0.0.1:3081/.well-known/agent-card.json`，A2A JSON-RPC 地址为 `http://127.0.0.1:3081/a2a`。

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

agent 通过 `call_a2a_agent` 调用另一个兼容 agent。只需提供远端 Agent Card URL 以及文本或 JSON 消息；如需继续远端对话，再传入之前返回的 `context_id`。默认启用流式响应，默认输出文本，`timeout_ms` 受 `outboundTimeoutMs` 上限约束。首个版本有意不提供出站认证字段，因此远端 URL 必须无需凭据即可访问。

运行 `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test` 可验证 bridge。

-----

<a id="operate-two-local-agents"></a>
## 运行两个本地 agent

先构建工作区，并只启动一次工单服务。然后打开两个 PowerShell 终端，为每个 Business Agent 分配独立的 `DSH_HOME` 和监听端口：

```powershell
powershell -File business-agent\start-dev.ps1 -NoOpen -Port 3081 -DshHome tmp\a2a-agent-a
powershell -File business-agent\start-dev.ps1 -NoOpen -Port 3082 -DshHome tmp\a2a-agent-b
```

Agent A 发布 `http://127.0.0.1:3081/.well-known/agent-card.json`，Agent B 发布 `http://127.0.0.1:3082/.well-known/agent-card.json`，各自的 JSON-RPC 路由是同端口的 `/a2a`。调用方以 Card URL 和消息开始远端对话，后续 `call_a2a_agent` 调用再传入返回的 `context_id`。每个进程都在其指定的 `DSH_HOME` 下保存自己的 Session 与 bridge 记录。

Card URL 是唯一发现输入。不要把 JSON-RPC URL 传给 `agent_card_url`，也不要附加 token、凭据、查询参数或片段。客户端每次调用都会重新获取 Card，因此接口变更无需重启调用方即可生效。

用 `Ctrl+C` 停止各进程。关闭期间不再接收新上下文，排队中与活动中的执行会收到终止信号，进程等待活动工作结束后关闭流与 bridge 存储。再次启动时，进程会把意外退出时仍未终止的 Task 标记为失败，同时保留已完成 Task 和上下文到 Session 的映射。

-----

<a id="expose-an-intranet-listener"></a>
## 暴露内网监听器

内置 Web 启动器有意只绑定回环地址。内网部署组合可以让共享 Host 监听器绑定 `0.0.0.0`，但此时若 `publicBaseUrl` 未指向其他节点实际访问的地址，或 `bearerTokenEnv` 未指向含非空 token 的环境变量，bridge 会拒绝加载：

```powershell
$env:BUSINESS_A2A_TOKEN = '<deployment-secret>'
```

```yaml
publicBaseUrl: http://10.20.30.40:3081
bearerTokenEnv: BUSINESS_A2A_TOKEN
```

Agent Card 保持公开。请求 `/a2a` 时必须携带 `Authorization: Bearer <deployment-secret>`。token 应保存在进程环境或部署密钥存储中；不要把它写入 `cordis.yml`、Agent Card URL、prompt 或 `call_a2a_agent`。首个版本不支持出站认证，因此要求 token 的 bridge 只能由在模型可见输入之外提供该请求头的 A2A 客户端调用。

当网络需要传输机密性时，应在内网入口或反向代理处终止 TLS。bridge 接受 HTTP 与 HTTPS URL，但不签发证书。

-----

<a id="operating-limits"></a>
## 运行限制

| 限制 | 默认值 | 允许的最大值 | 作用 |
|---|---:|---:|---|
| `requestTimeoutMs` | 300000 ms | 1800000 ms | 限制一次入站 Session turn |
| `outboundTimeoutMs` | 300000 ms | 1800000 ms | 限制 Card 发现与一次出站调用 |
| `maxRequestBytes` | 1048576 bytes | 67108864 bytes | 拒绝过大的入站 JSON-RPC body |
| `maxResponseBytes` | 4194304 bytes | 67108864 bytes | 拒绝过大的 Card 与远端响应 body |
| `maxConcurrentContexts` | 16 | 256 | 限制同时执行的上下文数量；同一上下文仍串行执行 |
| 出站重定向 | 4 | 固定 | 拒绝过多、不安全以及 HTTPS 到 HTTP 的重定向 |

bridge 保存上下文与 Task 记录，而不是无限增长的协议归档。部署应监控 Host 可用性、请求延迟、超时失败、响应大小失败和已配置的 storage domain。安全的协议与工具失败只包含稳定错误码和简短消息，不包含 token、prompt、reasoning、工具调用或完整远端响应 body。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

配置解析会在挂载路由前校验部署。Card 构建器根据规范化的公开 URL 和路由生成唯一的 A2A JSON-RPC 接口，声明支持流式响应但不支持推送通知，并描述入站 Bearer 认证而不把密钥复制到发现结果中。入站消息会创建或继续持久化 Session，bridge 的持久化记录保留 A2A 上下文与 Task 查询关系。出站调用会重新获取 Agent Card、选择其 A2A v1.0 JSON-RPC 接口、执行重定向/超时/响应字节限制，并在本地取消且已知 Task id 时尝试一次有界的远端取消。

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

模型可见的 `call_a2a_agent` 只有六个字段：`agent_card_url`、`message`、可选的 `context_id`、可选的 `stream`、可选的 `accepted_output_mode` 和可选的 `timeout_ms`。结果包含远端上下文 id、Task id、状态、输出；远端 Task 失败时只返回稳定诊断信息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 每个进程的发现接口只支持一张 Agent Card 和一个 JSON-RPC 接口。
- 出站认证、逐用户授权、推送通知、Task 列表、流式重新订阅、文件、媒体、gRPC 和 HTTP+JSON 不在已批准范围内。

<a id="dev-note"></a>
### 开发说明

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
