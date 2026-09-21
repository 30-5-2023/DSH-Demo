# A2A v0.3 兼容与内网监听设计

[English](2026-09-21-a2a-v03-lan-compatibility-design.md) | 中文

设计状态：等待书面设计审批。

## 摘要

Business Agent 与使用 Python `a2a-sdk==0.3.2` 构建的 agent 实现双向互操作，同时保留 A2A v1.0 作为主协议。一个可选的独立监听器只在内网地址上开放 A2A 发现和 JSON-RPC 路由，DSH Web 监听器继续使用回环地址。部署环境在运行时注入 Agent Card 声明的稳定地址，不把物理机或容器 IP 固化到镜像中。

本设计扩展现有的 [A2A Bridge 设计](2026-09-20-a2a-bridge-design.zh.md)。只有协议版本、监听器所有权、网络认证要求、配置和相关测试发生冲突时，本设计取代原文。

## 目录

- [目标](#goals)
- [约束](#constraints)
- [选定方案](#selected-approach)
- [协议兼容](#protocol-compatibility)
- [独立监听器](#dedicated-listener)
- [配置](#configuration)
- [生命周期与失败](#lifecycle-and-failures)
- [测试](#testing)
- [验收标准](#acceptance-criteria)
- [参考资料](#references)
- [非目标](#non-goals)

<a id="goals"></a>
## 目标

- 使用 `a2a-sdk==0.3.2` 的 Python 客户端能够发现本 Agent，并完成同步消息、流式消息、Task 查询和 Task 取消。
- 现有 `call_a2a_agent` 工具能够发现和调用使用 Python `a2a-sdk==0.3.2` 实现的 Agent。
- 现有 A2A v1.0 调用方和被调用方继续使用 v1.0，不发生协议降级。
- 内网中的另一台机器能够通过可直接访问的 URL 调用 A2A 端点。
- 容器镜像可以在不同宿主机、容器地址、Service 和 ingress 部署之间复用，因为它声明的访问 URL 来自运行时配置。

<a id="constraints"></a>
## 约束

- 实现全部位于 `business-agent/`，不修改 `packages/` 或 `apps/`。
- 现有 DSH Web 监听器继续只监听回环地址。内网暴露不得发布 Web UI、管理 API 或其他 Host 路由。
- 兼容目标是 Python 包版本 `0.3.2`，其线协议属于 A2A v0.3 系列。Agent Card 使用协议版本 `0.3` 声明兼容接口，不把包的补丁版本声明为线协议版本。
- 预研部署优先保证直接连通。独立内网监听器仍可配置 Bearer 认证，但认证是可选项，不属于验收条件。
- JSON-RPC 仍是唯一协议绑定。REST、gRPC、推送通知、Task 列表和流重新订阅仍不在范围内。

<a id="selected-approach"></a>
## 选定方案

A2A Bridge 在 Agent Card handler、JSON-RPC handler、Agent Card resolver 和 JSON-RPC transport factory 上启用官方 `@a2a-js/sdk` v0.3 兼容层。Agent Card 为同一端点分别声明 v1.0 和 v0.3 JSON-RPC 接口。SDK 在传输层转换 v0.3 线请求、响应、流事件、错误和 Agent Card；Bridge executor、Task store、Session 映射和模型可见工具继续使用 v1.0 内部类型。

插件还会增加一个可选的独立 HTTP 监听器。该监听器承载与现有实现相同的私有 Express 应用，只提供 `/.well-known/agent-card.json` 和配置的 JSON-RPC 路由，不注册任何 DSH Web 路由。省略监听器配置时，插件保留现有的共享回环监听行为，用于本地开发和兼容部署。

把共享 DSH Web 监听器绑定到 `0.0.0.0` 会暴露无关的 Host 能力，因此不采用该方案。只支持外部反向代理会阻止所需的直接启动流程，因此也不采用该方案作为唯一入口；部署方仍可在独立监听器前增加代理或 ingress。

<a id="protocol-compatibility"></a>
## 协议兼容

### Agent Card 发现

兼容目标的两个协议版本都使用 `/.well-known/agent-card.json`。Agent Card handler 启用 `legacyCompat`，并根据 `A2A-Version` 请求头返回不同响应。v1.0 请求获得 v1.0 Agent Card；缺少该请求头或请求 v0.3 时，响应包含 SDK 生成的 v0.3 兼容字段，其中包括 JSON-RPC URL 和传输声明。

规范的 v1.0 Agent Card 为同一 JSON-RPC URL 包含两个 `supportedInterfaces` 条目：一个使用 `protocolVersion: '1.0'`，另一个使用 `protocolVersion: '0.3'`。实现使用 SDK 兼容辅助函数，避免手写并维护两套接口声明。

### 入站 JSON-RPC

JSON-RPC handler 启用 `legacyCompat`。它接受 v1.0 方法名和当前 Bridge 需要的 v0.3 方法：`message/send`、`message/stream`、`tasks/get` 和 `tasks/cancel`。SDK 在分派前把 v0.3 请求字段转换为 Bridge 使用的 v1.0 请求类型，并在写出响应前把结果、流事件和失败转换回 v0.3 字段。

Bridge 保留现有的公开操作白名单。兼容能力不会开放当前不支持的 v0.3 方法。

### 出站调用

出站客户端在 `DefaultAgentCardResolver` 和 `JsonRpcTransportFactory` 上同时启用 `legacyCompat`。v0.3 Agent Card 会转换为带 v0.3 接口标记的 v1.0 内部 Agent Card 类型。只有选中该接口时，transport factory 才使用旧版 JSON-RPC transport；v1.0 Agent Card 继续使用原生 v1.0 transport。

`call_a2a_agent` 的输入和结果字段不变。工具仍接收明确的 Agent Card URL，协议选择继续由传输层负责，不允许模型直接指定协议版本。

<a id="dedicated-listener"></a>
## 独立监听器

Server 模块把 A2A Express 应用与承载适配器分开。一个适配器在 `ctx.webServer` 上注册该应用，保留现有共享模式；另一个适配器在独立模式下拥有一个 Node HTTP Server，并且只绑定配置的 host 和 port。

独立监听器只开放两个路由：

- `GET /.well-known/agent-card.json`
- `POST <route>`，默认值为 `/a2a`

其他路径全部返回 HTTP 404。独立 Server 不提供 DSH Web 应用，也不能分派到无关的 `ctx.webServer` 注册项。

`listener.host` 控制绑定地址。`0.0.0.0` 接收任意容器或宿主机网卡上的连接，但绝不写入 Agent Card。`publicBaseUrl` 控制返回给对端的地址，必须是对端能够解析和访问的地址。

容器部署通过运行时环境变量提供 `publicBaseUrl`，通常使用 Docker Compose 服务名、Kubernetes Service、ingress 域名、负载均衡地址或稳定宿主机地址。容器临时 IP 不是配置依据。

<a id="configuration"></a>
## 配置

```yaml
- id: business-a2a-bridge
  name: '@deepseek-ai/dsh-business-a2a-bridge'
  config:
    route: /a2a
    listener:
      host: 0.0.0.0
      port: 3082
    publicBaseUrl: !!js process.env.A2A_PUBLIC_BASE_URL
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

`listener` 是可选项。省略时，插件使用现有共享 Web 监听器并保留当前配置行为。配置该字段后，`host` 接受 `127.0.0.1` 或 `0.0.0.0`，`port` 接受 1 到 65535 之间可用的 TCP 端口。

共享模式和独立模式继续使用同一个 `publicBaseUrl` 字段声明外部地址。回环监听器省略该字段时，可以根据监听端口生成地址。监听 `0.0.0.0` 时必须提供明确的绝对 HTTP(S) 地址，并拒绝把 `0.0.0.0` 作为声明的主机名。Cordis 配置可以从 `A2A_PUBLIC_BASE_URL` 读取该值，因此同一镜像可以在不同部署中声明不同地址。

预研部署中，`bearerTokenEnv` 在两种模式下都是可选项。配置该字段后，现有校验、Agent Card 声明和请求检查行为保持不变。

启动脚本会增加 A2A 专用端口和声明地址参数，并把对应环境变量传递给子进程。常规 Web URL 继续是 `http://127.0.0.1:3081`；启用独立模式后，启动输出同时显示独立的 A2A Agent Card URL。

<a id="lifecycle-and-failures"></a>
## 生命周期与失败

插件在发布独立监听器前完成持久化和执行服务初始化。绑定失败会拒绝插件启动，并在诊断中包含请求的 host 和 port。只有路由应用和请求处理器准备完成后，监听器才开始接收流量。

关闭时，插件首先停止接收新的 HTTP 连接，再等待已经接收的 HTTP 响应关闭，然后完成 Server 释放。调度器、Session 跟踪器和存储继续遵循现有的完全停稳顺序。重复清理保证幂等；部分启动失败时，插件关闭失败前已经创建的所有资源。

无效协议请求继续返回 SDK 为对应协议版本生成的 A2A 错误。无效监听器配置在插件加载时失败。独立监听器绑定所有接口但缺少 `A2A_PUBLIC_BASE_URL` 时，插件在加载阶段失败，因为它不能通过猜测容器或宿主机地址来发布可访问的 Agent Card URL。

<a id="testing"></a>
## 测试

聚焦单元测试覆盖接口复制、按版本协商的 Agent Card、v0.3 与 v1.0 JSON-RPC 分派、出站 transport 选择、监听器配置、声明 URL 校验、绑定失败和幂等关闭。

协议集成测试通过同步、流式、查询和取消路径发送与 Python 0.3.2 兼容的 JSON fixture。现有 v1.0 测试继续保留，并验证 v1.0 客户端不会使用旧版 transport。

互操作 smoke fixture 在隔离的 Python 环境中使用真实 `a2a-sdk==0.3.2` 包。一个方向启动 Business Agent Server，并通过 Python 客户端驱动它；另一个方向启动最小 Python 0.3.2 Agent，并通过 `call_a2a_agent` 调用它。Smoke 会验证 Agent Card、方法名、请求与响应字段、流事件和终态输出，不只检查 HTTP 状态码。

网络测试在测试适配器内绑定 `127.0.0.1:0`，在 listening 事件后读取系统分配的地址，不依赖固定开发端口。内网验收 smoke 绑定 `0.0.0.0`，并在环境提供可访问网卡地址时通过该地址调用服务；CI 可以使用容器或回环路由，但必须经过相同的独立监听器代码路径。

实现同步更新包 README 双语文档、Business Agent 启动文档、bundle 配置、必要的模型可见录制快照，以及一份记录协议与监听器决策的 Agent Note。

<a id="acceptance-criteria"></a>
## 验收标准

- 使用 `a2a-sdk==0.3.2` 的 Python 客户端能够发现 Business Agent，并完成同步和流式消息。
- Python 客户端能够通过 v0.3 JSON-RPC 方法读取已完成 Task，并取消排队中或活动中的 Task。
- `call_a2a_agent` 无需模型可见的协议切换即可发现并调用 Python `a2a-sdk==0.3.2` Agent。
- 现有 v1.0 入站和出站集成测试继续通过，并选择 v1.0 transport。
- 内网中的另一台机器能够访问独立 Agent Card 和 JSON-RPC URL，同时 DSH Web 监听器仍只监听回环地址。
- 同一构建产物只需修改 `A2A_PUBLIC_BASE_URL` 即可使用不同声明地址，不需要编辑仓库文件或重新构建镜像。
- 停止或重新加载插件会关闭独立监听器并等待已接收响应完成，不残留监听进程。

<a id="references"></a>
## 参考资料

- [A2A Python SDK 0.3.2 changelog](https://github.com/a2aproject/a2a-python/blob/v0.3.2/CHANGELOG.md)
- [A2A Python SDK 0.3.2 types](https://github.com/a2aproject/a2a-python/blob/v0.3.2/src/a2a/types.py)
- [A2A JavaScript SDK v0.3 compatibility guide](https://github.com/a2aproject/a2a-js/blob/main/docs/compatibility-v0_3.md)
- [A2A JavaScript SDK compatibility implementation notes](https://github.com/a2aproject/a2a-js/blob/main/src/compat/v0_3/README.md)

<a id="non-goals"></a>
## 非目标

本次改动不会把共享 DSH Web 监听器暴露到网络，不会自动选择容器公开地址，不会增加 TLS 终止，不会要求预研环境必须认证，也不会增加远程 agent 注册表、REST 或 gRPC 协议绑定。生产环境认证、授权、可信代理处理、限流和公网加固需要独立的部署安全设计。
