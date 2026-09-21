# A2A Bridge 设计

[English](2026-09-20-a2a-bridge-design.md) | 中文

设计状态：已批准进入实施计划阶段。

## 摘要

Business Agent 对外提供一个符合 Agent2Agent（A2A）Protocol v1.0 的 agent，并通过模型可见工具调用其他 A2A agent。每个入站 A2A 上下文拥有一个持久化的 DeepSeek Harness Session，因此不同调用方相互隔离，并且调用方在进程重启后仍可继续对话。实现全部位于 `business-agent/`，不修改 `packages/` 或 `apps/`。

## 目录

- [目标](#goals)
- [约束](#constraints)
- [选定方案](#selected-approach)
- [架构](#architecture)
- [入站协议](#inbound-protocol)
- [出站工具](#outbound-tool)
- [持久化与并发](#persistence-and-concurrency)
- [安全](#security)
- [配置](#configuration)
- [失败行为](#failure-behavior)
- [测试](#testing)
- [验收标准](#acceptance-criteria)
- [参考资料](#references)
- [非目标](#non-goals)

<a id="goals"></a>
## 目标

第一版提供 A2A v1.0 JSON-RPC Server、SSE（Server-Sent Events）流式响应、标准 Agent Card、持久化 Task 查询、Task 取消，以及直接接收 Agent Card URL 的模型侧客户端工具。接口支持文本输入、结构化 JSON 输入、文本输出和按请求返回的结构化 JSON 输出。两个关闭入站认证的本地 Business Agent 实例无需预配置远程 agent 注册表即可相互发现和调用。

<a id="constraints"></a>
## 约束

- 本次改动通过 Cordis 插件和 Business Agent 组合包扩展现有 fork，不修改 DSH agent loop 或上游包 API。
- 一个服务实例只暴露一个可配置 Agent Card，并由当前 Business Agent 组合提供执行能力。
- 每个 A2A `contextId` 映射到一个专用且持久化的 DSH Session。不同上下文绝不共享会话历史。
- 第一版面向可信回环地址或内网部署。它允许直接传入 HTTP(S) Agent Card URL，并且不拦截私网地址。
- 回环地址可以不启用入站 Bearer 认证；Web Server 监听所有接口时必须启用认证。
- 第一版实现 Agent Card 发现、`SendMessage`、`SendStreamingMessage`、`GetTask` 和 `CancelTask`。Task 列表、Task 重新订阅、推送通知、扩展 Agent Card、文件 Part、音频、视频、gRPC 和 HTTP+JSON 不在范围内。

<a id="selected-approach"></a>
## 选定方案

在 `business-agent/plugins/a2a-bridge/` 下新增 `@deepseek-ai/dsh-business-a2a-bridge` 包，统一负责 A2A Server 适配器、远程客户端、持久化 A2A 记录和 `call_a2a_agent` 工具。该包使用官方 `@a2a-js/sdk` 处理 A2A v1.0 协议类型、请求分派、客户端行为和 SSE 帧。一个私有 Express router 承载 SDK 的 `agentCardHandler` 和 `jsonRpcHandler`；该 router 不监听端口，只在包注册到现有 `ctx.webServer` 的路由调用时运行。该包通过 `ctx.sessionController` 创建和恢复普通 Session，通过 `ctx.storageDomain` 保存非 Session A2A 记录，并通过 `ctx.tools` 注册出站工具。

SDK 的 `TaskStore` 适配器实现库要求的存储方法，同时公开操作白名单会拒绝本版批准的五项操作以外的 A2A 方法，并返回标准 unsupported-operation 错误。

该方案保持单进程部署，并符合当前 fork 只通过插件扩展的规则。独立网关进程会在产生实际需求前增加部署和状态同步成本。扩展 `ctx.subagents` 会修改公开的具名提供方 API，而第一版要求每次调用传入 URL，因此本设计把这项集成留作后续能力。

<a id="architecture"></a>
## 架构

```text
Remote A2A client
  |  A2A v1.0 JSON-RPC / SSE
  v
Business A2A Bridge
  |-- GET  /.well-known/agent-card.json
  |-- POST /a2a
  |-- A2A context/task persistence
  |-- DSH Session adapter
  `-- call_a2a_agent tool
          |
          |  Agent Card URL + A2A v1.0
          v
      Remote A2A agent

Business A2A Bridge -- ctx.sessionController --> Business Agent Session
Business A2A Bridge -- ctx.storageDomain -----> durable A2A records
Business A2A Bridge -- ctx.webServer --------> shared HTTP listener
```

包内模块分别负责 Server 路由、Agent 执行、远程调用、持久化、数据转换和工具注册。Cordis 入口模块负责配置校验和生命周期清理。路由、工具、监听器、流和存储注册均使用 Cordis effect，并在卸载期间释放至完全停稳。

Agent Card 只声明一个 agent。名称、描述、版本、skills、公开 URL 和输入输出媒体类型均来自经过校验的插件配置。Agent Card 只声明 JSON-RPC 和第一版实际实现的操作。

<a id="inbound-protocol"></a>
## 入站协议

### Agent 发现与认证

`GET /.well-known/agent-card.json` 始终返回公开 Agent Card。`POST /a2a` 接受 A2A v1.0 JSON-RPC 请求，并使用官方 SDK 处理的 v1 媒体类型。配置 `bearerTokenEnv` 后，Agent Card 声明 Bearer 安全方案及要求，`/a2a` 要求完全匹配的 Token。认证失败时，服务在 SDK 读取协议请求前返回 HTTP 401 和 `WWW-Authenticate: Bearer`。

### 上下文与 Session 创建

第一条不含 `contextId` 的消息会创建由服务生成的 `contextId`、`taskId` 和 DSH `sessionId`。Bridge 在接收提示词前持久化三者关系。后续携带该上下文的消息通过 `ctx.sessionController` 恢复同一个 Session；未知上下文返回 A2A not-found 失败，绝不静默创建替代 Session。

配置 `agentPreset` 后，Bridge 使用它创建 Session；否则使用组合的默认 preset 和模型选择。Bridge 把 A2A 创建的 Session 视为自有资源，不通过 A2A 暴露其 id，并按请求及所属轮次归属每个 Task。通过其他 Host 接口向这些 Session id 提交提示词不属于受支持行为。

### 消息转换

A2A Text Part 转换为 DSH 文本内容块。A2A Data Part 转换为带标签的序列化 JSON 块，标签明确说明远程值是不可信数据而不是指令。不支持的 Part 类型会在 Session 接收前导致请求失败。

默认响应模式生成 A2A Text Part。调用方接受 `application/json` 时，Bridge 添加一条写入日志的请求指令，要求模型仅返回一个 JSON 对象；Bridge 严格解析最终 assistant 文本并生成 Data Part。无效 JSON 会使 Task 失败，不会在 JSON 媒体类型下静默返回文本。

### Task 执行与流式响应

每条已接收消息都会获得一个由 A2A 消息 id 和 Task id 派生的持久请求标识。Bridge 使用持久化用户消息事件及其所属 DSH 轮次关联执行结果，并收集该轮次直到 `turn/end` 的 assistant 输出；它不会把整个进程范围的 Agent 空闲状态当作单条消息的结果。

`SendMessage` 等待关联轮次结束并返回最终 Task。`SendStreamingMessage` 依次发送 submitted 和 working 状态、关联轮次的 assistant 分片、最终产物以及终态。SSE 客户端断开只停止向该客户端发送帧，不会取消 Task。由于 Task 重新订阅不在范围内，调用方断线后通过 `GetTask` 读取持久化终态。

### 取消

`CancelTask` 保证幂等。取消排队中的 Task 会将其从 Bridge 队列移除并记录为 `canceled`，不会操作 Agent。取消活动 Task 会针对上下文当前轮次调用 `Agent.cancel()`，并在活动结算后记录 `canceled`。取消终态 Task 会直接返回已有状态。取消操作绝不删除上下文或 Session。

<a id="outbound-tool"></a>
## 出站工具

Bridge 注册一个模型可见的 `call_a2a_agent` 工具，输入字段如下：

| 字段 | 必填 | 含义 |
|---|---:|---|
| `agent_card_url` | 是 | 远程 Agent Card 的绝对 HTTP(S) URL |
| `message` | 是 | 要发送的文本或 JSON 值 |
| `context_id` | 否 | 要继续的远程上下文 |
| `stream` | 否 | 是否使用流式调用，默认为 `true` |
| `accepted_output_mode` | 否 | `text` 或 `json`，默认为 `text` |
| `timeout_ms` | 否 | 不超过配置上限的单次调用超时 |

工具每次调用都会获取并校验传入的 Agent Card，选择其中的 A2A v1.0 JSON-RPC 接口，通过官方客户端调用远程操作，并聚合状态、Part 和产物。工具结果返回远程 `contextId`、`taskId`、终态、输出，以及 Task 失败时的安全诊断信息。后续工具调用通过传入已返回的 `contextId` 继续远程对话。

本地工具在已知远程 Task id 后被取消时，客户端会在有界清理时限内尝试调用 `CancelTask`，随后结算本地调用。第一版不发送出站凭据，也不接收模型可见的 Authorization 工具参数或把凭据写入 Session 日志。

<a id="persistence-and-concurrency"></a>
## 持久化与并发

Bridge 声明一个带版本的存储域，其中包含 `contexts` 和 `tasks` 两张表。上下文记录保存 `contextId`、`sessionId`、创建时间和更新时间。Task 记录保存 `taskId`、`contextId`、输入消息 id、状态、时间戳、最终输出或产物元数据，以及稳定的失败摘要。Session 对话历史仍只由 DSH Session 持久化负责。

一个内存调度器按上下文串行执行 Task，同时允许不同上下文并发运行，最大并发数由 `maxConcurrentContexts` 限制。存储提交发生在对外可见状态变化之前。重复的 A2A 消息 id 会解析为已有 Task，绝不重复提交提示词。

Bridge 启动时把持久化的 `submitted` 或 `working` Task 标记为失败，并使用稳定的宿主执行中断原因，因为进程重启无法保留其内存执行所有权。它保留这些 Task 的上下文和 Session，允许后续消息继续对话。终态 Task 在重启后仍可查询。

<a id="security"></a>
## 安全

- `agent_card_url` 只接受绝对 `http:` 和 `https:` URL，拒绝内嵌凭据和 fragment，并执行请求与响应字节上限。
- 本设计明确允许私网 URL。由于第一版面向可信内网，部署方负责网络出站策略。
- 重定向只能保持或增强原始 scheme，绝不允许从 HTTPS 降级到 HTTP，并且重定向次数有上限。
- Bearer Token 只从配置指定的环境变量读取。服务使用抗时序分析的安全比较，并且日志绝不包含 Authorization 值。
- 公开 Agent Card 不包含凭据或敏感实现细节；A2A 端点受保护时，它会声明认证要求。
- 远程 Text Part 和 Data Part 都属于模型可见的不可信输入。转换过程会添加明确的数据标签，绝不把远程内容插入系统指令。
- 公开失败只包含稳定错误码和安全摘要。Host 日志保留关联 id 和内部异常，但不记录完整提示词、凭据或完整远程响应。

<a id="configuration"></a>
## 配置

```yaml
- id: business-a2a-bridge
  name: '@deepseek-ai/dsh-business-a2a-bridge'
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
    bearerTokenEnv: BUSINESS_A2A_TOKEN
    requestTimeoutMs: 300000
    outboundTimeoutMs: 300000
    maxRequestBytes: 1048576
    maxResponseBytes: 4194304
    maxConcurrentContexts: 16
```

所有随部署变化的限制都是经过校验的配置字段。Web Server 监听回环地址且端口已知时可以省略 `publicBaseUrl`；监听 `0.0.0.0` 时必须配置该字段。回环地址可以省略 `bearerTokenEnv`；监听 `0.0.0.0` 时必须配置该字段，并且对应环境变量值不得为空。实现把配置的最大值同时作为默认值和单次调用值的上限。

<a id="failure-behavior"></a>
## 失败行为

无效的认证、媒体类型、协议数据、Part、URL 和大小限制都会在模型执行前失败。未知上下文和 Task 返回 A2A not-found 失败。Session 创建、恢复、模型、工具、超时和转换失败会把已接收的 Task 转为 `failed`；任何已经提交的部分产物仍然挂在 Task 上。超时还会在 Task 结算前取消活动 Agent 轮次。

Bridge 使用官方 SDK 的标准 A2A 错误映射处理协议失败。内部 DSH 错误映射为稳定的 Bridge 错误码和安全消息。清理失败会独立写入日志，绝不改写已经提交的 Task 终态。

<a id="testing"></a>
## 测试

单元测试覆盖配置、认证、URL 校验、Part 转换、JSON 输出解析、状态迁移、幂等、持久化恢复、错误映射和 HMR（热模块替换）清理。协议集成测试使用官方 A2A 客户端调用真实 Bridge，并使用真实 Web Server、Session 控制器、Agent loop 和存储；只有 LLM（大语言模型）使用脚本化替身。出站测试使用临时官方 SDK A2A Server，验证同步、流式、上下文继续、取消、超时、大小限制和失败行为。

真实 loader 组合测试会启动 Business Agent Profile，并通过构建产物入口驱动 A2A。一个无密钥录制 Session 场景负责验证模型可见的 `call_a2a_agent` 工具 schema、调用、结果和 Session 事件。实现同时更新包和组合包文档；这项非平凡改动在实施前新增 proposed Agent Note，并在功能交付时将其提升为 implemented。

网络 fixture（测试前置数据）监听 `127.0.0.1:0`，并在 listening 事件后读取分配的地址。每个测试拥有独立临时存储根目录和唯一 id。测试使用明确事件或 barrier 同步，绝不使用固定 sleep；清理过程等待 SSE 关闭、HTTP Server 关闭、Agent 结算和存储关闭。测试避免修改进程全局 `fetch`、当前目录、计时器和环境变量。

<a id="acceptance-criteria"></a>
## 验收标准

- 官方 A2A v1.0 客户端能够发现配置的 Agent Card，并针对 Business Agent Profile 完成同步和流式消息。
- 使用同一上下文的第二条消息复用同一个 DSH Session，而不同上下文拥有相互独立的历史。
- Host 重启后，`GetTask` 仍可返回终态输出，并且同一上下文可以接收另一条消息。
- `CancelTask` 可以取消排队中和活动中的工作，但不会删除上下文。
- 关闭回环地址的入站认证后，一个 Business Agent 实例仅向 `call_a2a_agent` 传入另一个实例的 Agent Card URL 和消息即可调用对方。
- 出站工具返回可供模型继续远程上下文的标识与输出。
- 聚焦测试、真实组合测试、录制 Session 快照、类型检查、lint、构建和文档检查全部通过。

<a id="references"></a>
## 参考资料

- [A2A Protocol v1.0 specification](https://a2a-protocol.org/v1.0.0/specification/)
- [Official A2A JavaScript SDK](https://github.com/a2aproject/a2a-js)

<a id="non-goals"></a>
## 非目标

第一版不增加远程 agent 注册表、动态 Agent Card 管理、出站凭据传输、公网加固、Task 推送通知、Task 列表、流重新订阅、文件或媒体传输、多协议绑定、`ctx.subagents` 提供方、UI 控件或跨进程执行协调。这些能力应在核心 A2A 路径获得生产证据后分别设计。
