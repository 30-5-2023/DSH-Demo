---
description: "用于暴露并调用 A2A v1.0 与 v0.3 JSON-RPC agent 的配置和 Agent Card 约定。"
kind: "package-reference"
---

# Business A2A bridge

[English](README.md) | 中文

## 摘要

此包通过 A2A Protocol v1.0 与 v0.3 暴露 Business Agent，并让该 agent 通过 Agent Card URL 调用任一协议代际。它通过可选的 A2A 专用监听器提供发现、JSON-RPC 和限时文件下载，通过持久化 Session 执行入站工作，并注册用于远端调用和显式文件发布的模型可见工具。本地开发绑定回环地址；内网部署在运行时注入可达的公开 URL。

## 目录

- [使用此包](#use-this-package)
- [继续 input-required Task](#continue-input-required-tasks)
- [交换文件](#exchange-files)
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

在 `dsh` profile 中加载此插件。使用下方示例时，发现地址为 `http://127.0.0.1:3082/.well-known/agent-card.json`，A2A JSON-RPC 地址为 `http://127.0.0.1:3082/a2a`。

```yaml
- name: '@deepseek-ai/dsh-business-a2a-bridge'
  config:
    route: /a2a
    listener:
      host: 127.0.0.1
      port: 3082
    agent:
      name: Business Agent
      description: Internal business workflow agent
      version: 0.1.0
      defaultInputModes: [text/plain, application/json, application/octet-stream]
      defaultOutputModes: [text/plain, application/json, application/octet-stream]
      skills:
        - id: business-workflows
          name: Business Workflows
          description: Handle configured internal business workflows
          tags: [business]
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `route` | `/a2a` | 为 A2A JSON-RPC 保留的绝对非根路径 |
| `listener.host` | Bundle 中为 `127.0.0.1` | A2A 专用绑定地址：`127.0.0.1` 或 `0.0.0.0` |
| `listener.port` | Bundle 中为 `3082` | 1 至 65535 的 A2A 专用监听端口 |
| `publicBaseUrl` | 监听器回环 URL | Agent Card 声明的 HTTP(S) 基础地址；监听 `0.0.0.0` 时必填，且不得声明 `0.0.0.0` |
| `bearerTokenEnv` | 无 | 保存入站 Bearer token 的可选环境变量 |
| `agent` | 必填 | Agent 身份、模式以及至少一项对外声明的 skill |
| `inlineFileMaxBytes` | 1048576 bytes | 编码为 v0.3 `FileWithBytes` 的最大文件大小 |
| `maxFileBytes` | 268435456 bytes | 准入、获取、发布、发送或本地化文件的最大大小 |
| `fileRetentionMs` | 86400000 ms | 不透明托管文件 URL 的有效期 |
| `fileUrlAllowedOrigins` | `[]` | 入站 URI 文件和远端输出文件额外允许的精确 HTTP(S) origin |
| `publishFileAllowedRoots` | `[]` | 除 Session workspace 外允许本地发布和出站文件使用的绝对根目录 |
| 请求与响应限制 | 有界默认值 | 正数的超时、字节数和并发上下文限制 |

agent 通过 `call_a2a_agent` 调用另一个兼容 agent。提供远端 Agent Card URL 以及文本或 JSON 消息，可选添加本地 `files`；如需继续远端对话，再传入之前返回的 `context_id`。结果为 `input-required` 时，应把其 `task_id` 与答案一起传入，让下一次调用继续同一 Task。默认启用流式响应，默认输出文本，`timeout_ms` 受 `outboundTimeoutMs` 上限约束。工具不提供出站认证字段，因此远端 URL 必须无需凭据即可访问。

运行 `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test` 可验证 bridge。
运行 `pwsh -NoProfile -File business-agent/verify-a2a-python-v032.ps1` 会创建隔离 venv，并使用精确的 Python `a2a-sdk==0.3.2` 验证两个方向。

-----

<a id="continue-input-required-tasks"></a>
## 继续 input-required Task

入站 A2A Session 调用 `ask_user_question` 时，bridge 会以 `input-required` 返回该 Task。其状态 Message 包含便于阅读的 TextPart，以及 schema 为 `urn:deepseek-harness:a2a:input-required:v1` 的 DataPart；DataPart 保留问题 id、提示、选项标签与说明、多选标志和可选详情。

调用方可以用一个 DataPart 回答；该 DataPart 使用 schema `urn:deepseek-harness:a2a:input-response:v1` 和 `answers` 数组。每个条目通过 `id` 指明待回答问题，在 `selected` 中给出所选选项标签，并可包含 `custom` 文本。非空纯 TextPart 也可作为第一个待回答问题的自定义答案。无效的结构化答案会让 Task 保持 `input-required`，并返回安全的纠正消息。

v0.3 调用方通过 `tasks/get` 读取待处理或最终状态；bridge 不提供 `message/get` 方法。问题待处理时，`tasks/get` 返回同一 Task 及其状态 Message。调用方使用该 Task id 通过 `message/send` 或 `message/stream` 继续执行。出站工具把同一流程表示为 `interaction` 与 `task_id`，下一次 `call_a2a_agent` 把该 `task_id` 与答案一起传入。

input-required 状态也可携带用于说明的 FilePart。`call_a2a_agent` 会把这些文件物化到 `result.interaction` 旁的 `result.files` 中，但 FilePart 不能回答 `ask_user_question`；答案仍需使用结构化 DataPart 或非空 TextPart。

待回答问题保存在内存中，而 Task 状态持久化。它会保留该上下文的串行锁和一个 `maxConcurrentContexts` 槽位，直到收到答案、取消、关闭或达到入站 `requestTimeoutMs` 截止时间；Bundle 默认值为五分钟。进程重启会把中断的 Task 标记为失败，因为无法重建内存中的问题续接；无关上下文仍在配置的并发上限内继续运行。

-----

<a id="exchange-files"></a>
## 交换文件

Python `a2a-sdk==0.3.2` 把文件表示为包含 `FileWithBytes` 或 `FileWithUri` 的 `FilePart`。bridge 把不超过 `inlineFileMaxBytes` 的文件作为规范 base64 bytes 发送，把更大的文件作为 A2A 专用监听器提供的不透明 URL 发送。未配置专用监听器时仍可使用内联文件，但更大的文件会以 `A2A_FILE_URL_UNAVAILABLE` 失败，而不会返回无法访问的 URL。超过 `maxFileBytes` 的文件在进入 Session 或结果前会被拒绝。

入站 URI 文件必须使用 `fileUrlAllowedOrigins` 中的精确 origin。对于被调用 agent 返回的文件，Agent Card 的 origin 也被允许。每次重定向都会重新校验；凭据、fragment、HTTPS 到 HTTP 降级、过多重定向、超时、取消和实测大小超限都会失败，并且不会暴露不完整的本地结果。

`publish_a2a_file` 相对于活动 Session workspace 或 `publishFileAllowedRoots` 解析 `path`，把 bytes 快照到 DSH attachment，并在完成 Task Artifact 的普通文本或 JSON 输出之后附加文件。`call_a2a_agent.files` 使用相同的本地路径规则，并保留消息和文件顺序。返回的文件 Part 在 `result.files` 中表示为本地绝对 `path`、`name`、`mime_type`、`bytes` 和 `artifact_id`；该路径属于调用方部署，不是远端 agent 上的路径。

大文件输出 URL 使用 `${route}/files/:token` 上的 `GET` 或 `HEAD`，拒绝 range 请求，并在 `fileRetentionMs` 后过期。只要元数据和 attachment 仍然存在，该 URL 在进程重启后仍可使用。另一台机器通过 HTTP 从 `publicBaseUrl` 接收 bytes，永远不会获得源文件系统路径的访问权。

在当前无认证预研部署中，不透明 token 本身授予下载权限。监听器应只位于可信网络，避免记录 URL；把下载接口暴露到不可信网络前，需要单独设计生产授权方案。

-----

<a id="operate-two-local-agents"></a>
## 运行两个本地 agent

先构建工作区，并只启动一次工单服务。然后打开两个 PowerShell 终端，为每个 Business Agent 分配独立的 `DSH_HOME` 和监听端口：

```powershell
powershell -File business-agent\start-dev.ps1 -NoOpen -Port 3081 -A2APort 3082 -DshHome tmp\a2a-agent-a
powershell -File business-agent\start-dev.ps1 -NoOpen -Port 3091 -A2APort 3092 -DshHome tmp\a2a-agent-b
```

Agent A 发布 `http://127.0.0.1:3082/.well-known/agent-card.json`，Agent B 发布 `http://127.0.0.1:3092/.well-known/agent-card.json`，各自的 JSON-RPC 路由是同端口的 `/a2a`。调用方以 Card URL 和消息开始远端对话，后续 `call_a2a_agent` 调用再传入返回的 `context_id`。每个进程都在其指定的 `DSH_HOME` 下保存自己的 Session 与 bridge 记录。

Card URL 是唯一发现输入。不要把 JSON-RPC URL 传给 `agent_card_url`，也不要附加 token、凭据、查询参数或片段。客户端每次调用都会重新获取 Card，因此接口变更无需重启调用方即可生效。

用 `Ctrl+C` 停止各进程。关闭期间不再接收新的监听器连接和上下文，进程等待已接收 HTTP 响应与活动工作结束后关闭流与 bridge 存储。再次启动时，进程会把意外退出时仍未终止的 Task 标记为失败，同时保留已完成 Task 和上下文到 Session 的映射。

-----

<a id="expose-an-intranet-listener"></a>
## 暴露内网监听器

Web 监听器仍使用 `127.0.0.1:3081`。下面的命令只让 A2A 专用监听器绑定所有接口，并声明其他内网机器可访问的地址：

```powershell
powershell -File business-agent\start-dev.ps1 -NoOpen `
  -A2AHost 0.0.0.0 `
  -A2APublicBaseUrl http://192.168.1.10:3082
```

`0.0.0.0` 是绑定地址，不是客户端 URL。应在运行时把 `A2A_PUBLIC_BASE_URL` 设为对端可解析的稳定主机地址、DNS 名称、Docker Compose 服务、Kubernetes Service、ingress 或负载均衡器。预研监听器允许直接无认证调用；部署在模型可见输入之外提供 token 时，可配置 `bearerTokenEnv`。

Business Bundle 把 `A2A_INLINE_FILE_MAX_BYTES`、`A2A_MAX_FILE_BYTES` 和 `A2A_FILE_RETENTION_MS` 读取为整数覆盖值，并把 `A2A_FILE_URL_ALLOWED_ORIGINS` 和 `A2A_PUBLISH_FILE_ALLOWED_ROOTS` 读取为逗号分隔列表。Docker 或 Kubernetes 必须在运行时注入这些值和 `A2A_PUBLIC_BASE_URL`；不要把机器或 pod IP 写入镜像。

在另一台机器上运行 `Invoke-RestMethod http://192.168.1.10:3082/.well-known/agent-card.json` 可验证发现接口。必要时在主机防火墙中开放 TCP 3082。网络需要传输机密性时，应在 ingress 或反向代理处终止 TLS；bridge 接受 HTTP 与 HTTPS URL，但不签发证书。

-----

<a id="operating-limits"></a>
## 运行限制

| 限制 | 默认值 | 允许的最大值 | 作用 |
|---|---:|---:|---|
| `requestTimeoutMs` | 300000 ms | 1800000 ms | 限制一次入站 Session turn，包括 input-required 等待 |
| `outboundTimeoutMs` | 300000 ms | 1800000 ms | 限制 Card 发现与一次出站调用 |
| `maxRequestBytes` | 2097152 bytes | 67108864 bytes | 拒绝过大的入站 JSON-RPC body |
| `maxResponseBytes` | 4194304 bytes | 67108864 bytes | 拒绝过大的 Card 与远端响应 body |
| `maxConcurrentContexts` | 16 | 256 | 限制同时执行的上下文数量；同一上下文仍串行执行 |
| `inlineFileMaxBytes` | 1048576 bytes | 4294967296 bytes | 阈值及以下选择内联 bytes；有专用监听器时，阈值以上选择托管 URI |
| `maxFileBytes` | 268435456 bytes | 4294967296 bytes | 实测 bytes 超过限制时拒绝文件 |
| `fileRetentionMs` | 86400000 ms | 2592000000 ms | 让托管文件链接过期；最小值为 60000 ms |
| 出站重定向 | 4 | 固定 | 拒绝过多、不安全以及 HTTPS 到 HTTP 的重定向 |

bridge 保存上下文与 Task 记录，而不是无限增长的协议归档。部署应监控 Host 可用性、请求延迟、超时失败、响应大小失败和已配置的 storage domain。安全的协议与工具失败只包含稳定错误码和简短消息，不包含 token、prompt、reasoning、工具调用或完整远端响应 body。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

配置解析会在绑定前校验监听器、声明地址、精确文件 origin、绝对发布根目录及相关大小不变量。Card 与 JSON-RPC 处理器通过官方 SDK 兼容层协商 v1.0 和 v0.3，bridge 内部仍使用 v1.0 类型。每个准入文件都通过 attachment 服务生成快照；单独的 storage domain 只持有不透明链接元数据和过期时间。私有 Express 应用只在专用监听器上暴露下载。入站消息创建或继续持久化 Session；出站调用选择 Card 声明的协议接口，并保留重定向、超时、大小和有界取消策略。宿主范围的 `global` 与 `prepend` 问题监听器会先观察有作用域的问题，只认领具有开放 Task 窗口的精确实时 A2A Session id，并立即把所有无关问题委托给普通 UI 回答链。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [A2A bridge 设计](../../../../docs/superpowers/specs/2026-09-20-a2a-bridge-design.md) — 已批准的协议、持久化、生命周期和安全决策
- [A2A v0.3 与 LAN 设计](../../../../docs/superpowers/specs/2026-09-21-a2a-v03-lan-compatibility-design.md) — 兼容性、监听器隔离与运行时地址决策
- [A2A v0.3 文件设计](../../../../docs/superpowers/specs/2026-09-22-a2a-v03-file-artifacts-design.md) — 文件 Part、attachment 所有权、托管链接和传输策略
- [Business Agent 设计](../../../DESIGN.md) — 组合方式和业务系统集成模型
- [Subagent 能力决策](../../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md) — 本地与产品进程委派模型

-----

<a id="model-experience"></a>
## 模型体验

模型可见的 `call_a2a_agent` 包含 `agent_card_url`、`message`、可选的 `files`、可选的 `context_id`、可选的 `task_id`、可选的 `stream`、可选的 `accepted_output_mode` 和可选的 `timeout_ms`。结果包含远端上下文 id、Task id、状态、最终文本或 JSON 输出、input-required `interaction` 文本与数据、本地化文件元数据和路径；远端 Task 失败时只返回稳定诊断信息。模型也会获得 `publish_a2a_file`；它返回 attachment 元数据，但不会嵌入文件 bytes 或下载 token。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 每个进程的发现接口只支持一张包含 v1.0 与 v0.3 JSON-RPC 接口的 Agent Card。
- 出站认证、逐用户授权、推送通知、Task 列表、流式重新订阅、v1.0 文件兼容性、非文件媒体、可恢复下载、gRPC 和 HTTP+JSON 不在已批准范围内。

<a id="dev-note"></a>
### 开发说明

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
