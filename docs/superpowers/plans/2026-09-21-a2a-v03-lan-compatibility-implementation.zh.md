# A2A v0.3 兼容与内网监听实施计划

[English](2026-09-21-a2a-v03-lan-compatibility-implementation.md) | 中文

> **供 agent worker 使用：** 必须使用子技能 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项实施本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 让 Business Agent 与 Python `a2a-sdk==0.3.2` 实现双向互操作，并通过可选的内网监听器只暴露 A2A 路由。

**架构：** Bridge 启用官方 `@a2a-js/sdk` 旧版兼容适配器，同时保留 v1.0 内部类型和传输优先级。私有 Express 应用与承载适配器分离，使插件既可以把它注册到共享回环 Web Server，也可以通过独立 Node HTTP 监听器提供服务；声明地址在运行时注入。

**技术栈：** TypeScript、Cordis、Node HTTP、Express 5.2.1、`@a2a-js/sdk` 1.2.0、Node test runner、PowerShell、Python `a2a-sdk==0.3.2`、httpx、Starlette/Uvicorn。

**设计文档：** [A2A v0.3 兼容与内网监听设计](../specs/2026-09-21-a2a-v03-lan-compatibility-design.zh.md)

## 全局约束

- 所有产品改动保留在 `business-agent/`，不修改 `packages/` 或 `apps/`。
- 保持 A2A v1.0 为优先协议，增加 v0.3 兼容时不修改 `call_a2a_agent` 工具 schema。
- 目标 Python 包是 `a2a-sdk==0.3.2`；其线协议声明为 `0.3`，而不是 `0.3.2`。
- JSON-RPC 仍是唯一协议绑定，只支持发送、流式发送、Task 查询和取消。
- DSH Web 监听器继续监听回环地址；内网监听器只开放 Agent Card 和配置的 A2A JSON-RPC 路由。
- 允许预研监听器不使用 Bearer 认证。配置 `bearerTokenEnv` 后保留 token 校验和强制执行。
- 绝不声明 `0.0.0.0`；有效 A2A 监听器绑定所有接口时，必须明确配置 HTTP(S) `publicBaseUrl`。
- `publicBaseUrl` 来自运行时配置，因此容器和宿主机地址绝不写入镜像或检入的部署值。
- 所有注册使用 Cordis effect，并执行可等待且幂等的清理。监听器释放必须先停止接收，再等待活动响应。
- 每个实现切片都先编写失败的聚焦测试，观察指定失败，加入最小实现使其通过，再提交该切片。

## 审查重点

1. Python 0.3.2 客户端不发送 `A2A-Version`；Card 发现必须返回旧版可解析的 Card，而不是仅支持 v1 的 Card。
2. 启用旧版兼容后，v1.0 对端必须继续选择原生 v1 方法；兼容能力不得静默降级现代流量。
3. 通配监听器缺少声明主机名或声明为 `0.0.0.0` 时，必须在加载阶段失败，不能返回不可访问的 Agent Card URL。
4. 独立端口冲突或部分启动失败时，必须关闭此前创建的全部 Bridge 资源，不得残留监听器。
5. 存在已接收的流式响应时，关闭过程必须停止新连接，并等待该响应结束后再结算插件 effect。

## 文件映射

- 修改 `business-agent/plugins/a2a-bridge/src/types.ts`，增加监听器配置和解析后的端点类型。
- 修改 `business-agent/plugins/a2a-bridge/src/config.ts`，增加监听器感知的校验和可选内网认证。
- 修改 `business-agent/plugins/a2a-bridge/src/card.ts`，声明明确的 v1.0 与 v0.3 JSON-RPC 接口。
- 新建 `business-agent/plugins/a2a-bridge/src/http-app.ts`，负责私有 Express 应用、请求准入跟踪、认证和 HTTP 失败。
- 修改 `business-agent/plugins/a2a-bridge/src/server.ts`，实现共享与独立承载适配器。
- 修改 `business-agent/plugins/a2a-bridge/src/index.ts`，实现异步 Server 启动和失败清理。
- 修改 `business-agent/plugins/a2a-bridge/src/client.ts`，实现 v0.3 感知的 Card 解析和 JSON-RPC 选择。
- 修改 `business-agent/plugins/a2a-bridge/test/config-card.test.mjs`、`server.test.mjs` 和 `client-tool.test.mjs`，增加聚焦兼容性与生命周期覆盖。
- 新建 `business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs`，执行可选的精确版本互操作测试。
- 新建 `business-agent/tests/fixtures/a2a-python-v032-peer.py` 和 `a2a-python-v032-requirements.txt`，提供真实 Python 对端。
- 新建 `business-agent/verify-a2a-python-v032.ps1`，提供可复现的 venv 安装和精确版本 smoke。
- 修改 `business-agent/bundle/cordis.patch.yml` 和 `business-agent/bundle/test/config.mjs`，接入运行时监听值。
- 修改 `business-agent/start-dev.ps1`，提供独立的 Web 与 A2A 启动参数和 URL。
- 修改 A2A 插件、Bundle、Business Agent 和迁移 README 双语文件及其配对记录。
- 修改 `.agents/notes/implemented/feature/2026-09-20-a2a-bridge.md`、中文版本及其配对记录，使现有决策所有者与交付行为一致。

## Task 1：解析监听器配置并声明两个协议版本

**文件：** 修改 `business-agent/plugins/a2a-bridge/` 下的 `src/types.ts`、`src/config.ts`、`src/card.ts` 和 `test/config-card.test.mjs`。

**接口：**

```ts
export interface A2AListenerConfig {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
}

export interface ResolvedA2AConfigCore {
  readonly listener?: A2AListenerConfig
  readonly publicBaseUrl: URL
  readonly route: string
  readonly cardPath: '/.well-known/agent-card.json'
}
```

- [ ] **Step 1：扩展配置测试并固定双接口约定。** 断言 `supportedInterfaces.map(({ protocolVersion }) => protocolVersion)` 等于 `['1.0', '0.3']`，两个条目使用相同 `/a2a` URL 和 `JSONRPC`，重复构造 Card 绝不增加第三个接口。
- [ ] **Step 2：增加失败的监听器校验用例。** 覆盖 `listener.host` 不属于 `127.0.0.1 | 0.0.0.0`、端口 `0` 与 `65536`、通配绑定缺少 `publicBaseUrl`，以及 `publicBaseUrl: http://0.0.0.0:3082`；同时断言通配绑定不配置 `bearerTokenEnv` 时现在可以成功解析。
- [ ] **Step 3：运行聚焦测试并观察旧行为。** 运行 `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/config-card.test.mjs`；预期单接口断言和通配无 token 断言失败。
- [ ] **Step 4：增加监听器类型和 Schemastery 字段。** 增加可选的 `listener.host` 与 `listener.port`，校验封闭 host 集合和 1 至 65535 的端口；存在 `listener` 时从中计算有效 host 和 port，否则使用 `A2ADeployment`。
- [ ] **Step 5：分离声明地址与认证规则。** 仅在有效 host 为 `0.0.0.0` 时要求 `publicBaseUrl`，拒绝声明主机名等于 `0.0.0.0`，移除 `bearerTokenEnv` 的通配强制要求，同时在配置该字段时继续执行非空环境变量查找。
- [ ] **Step 6：构造明确的 v1.0 与 v0.3 接口。** 使用官方辅助函数，不手工复制字段：

```ts
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3'

const supportedInterfaces = duplicateInterfacesForLegacy([{
  url: rpcUrl.href,
  protocolBinding: 'JSONRPC',
  tenant: '',
  protocolVersion: '1.0',
}], ['JSONRPC'])
```

- [ ] **Step 7：运行聚焦测试和包构建。** 运行 Step 3 的命令；预期全部配置与 Card 断言通过。
- [ ] **Step 8：提交配置切片。** 运行 `git add business-agent/plugins/a2a-bridge/src/{types,config,card}.ts business-agent/plugins/a2a-bridge/test/config-card.test.mjs && git commit -m "feat(business-agent): advertise A2A v0.3 compatibility"`。

## Task 2：启用入站 v0.3 并增加独立监听器

**文件：** 新建 `src/http-app.ts`；修改 `src/server.ts`、`src/index.ts`、`test/server.test.mjs` 和 `src/index.ts` 中的包导出。

**接口：**

```ts
export interface A2AHttpApplication {
  readonly dispatch: import('node:http').RequestListener
  close(): Promise<void>
}

export interface A2AServer {
  readonly cardUrl: URL
  readonly rpcUrl: URL
  close(): Promise<void>
}

export function createA2AHttpApplication(config: ResolvedA2AConfig, handler: A2ARequestHandler): A2AHttpApplication
export async function createA2AServer(ctx: Context, config: ResolvedA2AConfig, handler: A2ARequestHandler): Promise<A2AServer>
```

- [ ] **Step 1：增加失败的旧版 Card 测试。** 不带 `A2A-Version` 获取 Card，并断言 JSON 包含 v0.3 字段 `protocolVersion`、`url` 和 `preferredTransport`；再带 `A2A-Version: 1.0` 获取，并断言 v1 `supportedInterfaces` 数组仍然存在。
- [ ] **Step 2：增加失败的 v0.3 JSON-RPC 测试。** POST 使用 Python 0.3.2 字段名的 `message/send`、`message/stream`、`tasks/get` 和 `tasks/cancel` 请求；断言 v0.3 Task 状态与 Part，并断言不支持的旧版方法收到对应协议版本的 SDK 错误。
- [ ] **Step 3：增加独立承载测试。** 使用 `127.0.0.1:0` 调用低层监听适配器，通过系统分配的端口调用真实 Express 应用，断言 Card 与 RPC 成功、无关路径返回 404，并断言独立模式下共享 Web Server 的 A2A 路径仍返回 404。
- [ ] **Step 4：增加审查重点生命周期测试。** 使用明确 barrier 阻塞流式响应，调用 `close()`，断言第二个连接被拒绝，释放 barrier 后断言 close 结算；启动前占用端口，并断言绑定错误发生后共享注册项和活动响应集合为空。
- [ ] **Step 5：运行 Server 测试并观察失败。** 运行 `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/server.test.mjs`；预期缺少旧版字段、v0.3 方法返回 method-not-found，以及缺少独立适配器的用例失败。
- [ ] **Step 6：抽取私有 HTTP 应用。** 把方法检查、可选 Bearer 中间件、JSON 大小限制、SDK handler、安全错误中间件和活动响应集合移入 `http-app.ts`；在两个 handler 上启用兼容：

```ts
const legacyCompat = { enabled: true } as const
const card = agentCardHandler({ agentCardProvider: handler, legacyCompat })
const rpc = jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication, legacyCompat })
```

- [ ] **Step 7：实现两个承载适配器。** 共享模式通过 `ctx.webServer` 注册精确路径。独立模式创建一个 Node HTTP Server，绑定 `config.listener.host` 与 `config.listener.port`，不开放其他路由；关闭时先停止准入，等待 `server.close()`，再等待 `A2AHttpApplication.close()`。
- [ ] **Step 8：让插件异步启动并安全处理失败。** 在 `apply` 中等待 `createA2AServer`；发生绑定或路由错误时，只调用一次现有 `closeBridge` 路径，然后重新抛出原始启动错误；只有清理也失败时才通过 `AggregateError` 附带清理失败。
- [ ] **Step 9：运行 Server 测试和包构建。** 重复 Step 5；预期 v0.3、v1.0、独立监听、绑定冲突和完全停稳关闭用例通过。
- [ ] **Step 10：提交入站与监听器切片。** 运行 `git add business-agent/plugins/a2a-bridge/src/{http-app,server,index}.ts business-agent/plugins/a2a-bridge/test/server.test.mjs && git commit -m "feat(business-agent): add dedicated A2A listener"`。

## Task 3：启用出站 v0.3 且不降级 v1.0

**文件：** 修改 `src/client.ts` 和 `test/client-tool.test.mjs`。

**接口：** 保持 `A2AAgentClient.call(input, signal)` 和 `call_a2a_agent` 的六个输入字段不变。

- [ ] **Step 1：为远程 fixture 增加旧版模式。** 通过启用兼容的 Card handler 提供双接口 Card，在 JSON-RPC handler 上启用兼容，并在分派前记录收到的 JSON-RPC 方法名。
- [ ] **Step 2：增加失败的 v0.3 出站测试。** 以同步和流式方式调用旧版 fixture，继续返回的 context，并断言 fixture 观察到 `message/send`、`message/stream` 和 `tasks/get`，而不是 v1 PascalCase 方法名。
- [ ] **Step 3：增加 v1 不降级断言。** 调用现有 v1 fixture，并断言它仍观察到 `SendMessage` 或 `SendStreamingMessage`；在同一测试进程运行两种模式，防止 factory 状态在调用之间泄漏。
- [ ] **Step 4：运行客户端测试并观察失败。** 运行 `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/client-tool.test.mjs`；预期旧版 Card 解析或 v0.3 方法断言失败。
- [ ] **Step 5：在两个出站决策点启用兼容。** 按以下方式配置现有有界 fetch：

```ts
const cardResolver = new DefaultAgentCardResolver({
  fetchImpl: createBoundedFetch({ ...common, signal }),
  legacyCompat: { enabled: true },
})
const transport = new JsonRpcTransportFactory({
  fetchImpl: createStreamingBoundedFetch(common),
  legacyCompat: { enabled: true },
})
```

- [ ] **Step 6：保持传输层负责协议选择。** 不向 `CallA2AAgentInput` 增加版本字段；由规范化后的 Agent Card 接口选择旧版或 v1 transport，并保留当前取消、超时、大小限制和安全失败行为。
- [ ] **Step 7：运行聚焦测试和包构建。** 重复 Step 4；预期旧版调用、原生 v1 调用、现有失败安全和未变化的工具 schema 全部通过。
- [ ] **Step 8：提交出站切片。** 运行 `git add business-agent/plugins/a2a-bridge/src/client.ts business-agent/plugins/a2a-bridge/test/client-tool.test.mjs && git commit -m "feat(business-agent): call A2A v0.3 agents"`。

## Task 4：接入运行时地址注入与启动命令

**文件：** 修改 `business-agent/bundle/cordis.patch.yml`、`business-agent/bundle/test/config.mjs` 和 `business-agent/start-dev.ps1`。

**接口：** Bundle 读取 `A2A_LISTEN_HOST`、`A2A_LISTEN_PORT` 和 `A2A_PUBLIC_BASE_URL`。启动脚本提供 `-A2AHost`、`-A2APort` 和 `-A2APublicBaseUrl`，并通过三个环境变量传递这些值。

- [ ] **Step 1：让 Bundle 测试期待独立回环监听器。** 断言求值后的配置默认解析为 host `127.0.0.1`、port `3082` 且省略 public base；增加环境控制用例，解析 `0.0.0.0`、`3182` 和 `http://agent.internal:3182`。
- [ ] **Step 2：运行 Bundle 测试并观察失败。** 运行 `pnpm --filter @deepseek-ai/dsh-business-agent test`；预期 A2A 配置断言失败。
- [ ] **Step 3：向 Bundle patch 增加运行时表达式。** 使用部署环境拥有的值，不检入固定 IP：

```yaml
listener:
  host: !!js process.env.A2A_LISTEN_HOST ?? '127.0.0.1'
  port: !!js Number(process.env.A2A_LISTEN_PORT ?? 3082)
publicBaseUrl: !!js process.env.A2A_PUBLIC_BASE_URL
```

- [ ] **Step 4：更新配置测试加载器以支持 `!!js`。** 为 `tag:yaml.org,2002:js` 构造 `js-yaml` scalar type，只使用传入的环境对象求值该 fixture 拥有的三个精确表达式，并拒绝任何未识别表达式，避免测试成为通用代码求值器。
- [ ] **Step 5：增加启动参数和校验。** `-A2AHost` 默认值为 `127.0.0.1`，`-A2APort` 默认值为 `3082`；选择 `-A2AHost 0.0.0.0` 但未设置 `-A2APublicBaseUrl` 时，在 Profile 设置前失败，并给出 `http://192.168.1.10:3082` 形式的示例。
- [ ] **Step 6：导出运行时值并打印两个地址。** 只为子进程设置三个 A2A 环境变量，Web URL 保持为 `127.0.0.1:$Port`，并根据 `-A2APublicBaseUrl` 或回环默认值打印准确的 Agent Card 与 RPC URL。
- [ ] **Step 7：安全扩展 `-ReplaceExisting`。** 只解析并停止 `$Port` 与 `$A2APort` 上的精确监听器，报告每个 PID，不影响其他进程。
- [ ] **Step 8：运行 Bundle 与启动脚本检查。** 运行 Bundle 测试、`powershell -NoProfile -File business-agent/start-dev.ps1 -?` 和 PowerShell parser 校验；预期配置断言与参数帮助通过，且不启动应用。
- [ ] **Step 9：提交部署切片。** 运行 `git add business-agent/bundle/cordis.patch.yml business-agent/bundle/test/config.mjs business-agent/start-dev.ps1 && git commit -m "feat(business-agent): configure A2A LAN startup"`。

## Task 5：验证真实 Python 0.3.2 互操作

**文件：** 新建 `business-agent/tests/fixtures/a2a-python-v032-requirements.txt`、`a2a-python-v032-peer.py`、`business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs` 和 `business-agent/verify-a2a-python-v032.ps1`；仅在明确脚本名有助于发现时修改插件包测试脚本。

**接口：** `a2a-python-v032-peer.py client <base-url>` 驱动 JavaScript Bridge。`a2a-python-v032-peer.py server` 打印一行包含系统分配 `baseUrl` 的 JSON，然后持续提供服务直到被终止。`DSH_A2A_PYTHON032` 指定 Node 测试使用的隔离解释器。

- [ ] **Step 1：固定真实解析包。** 在 `a2a-python-v032-requirements.txt` 中只写入 `a2a-sdk[http-server]==0.3.2`；Python 脚本在运行任何模式前必须断言 `importlib.metadata.version('a2a-sdk') == '0.3.2'`。
- [ ] **Step 2：编写 Python 客户端模式。** 使用 `A2ACardResolver` 解析 `/.well-known/agent-card.json`，构造 `ClientFactory(ClientConfig(httpx_client=client, streaming=True))`，并发送以下包原生消息：

```py
message = Message(
    role=Role.user,
    message_id=str(uuid.uuid4()),
    parts=[Part(root=TextPart(text='python-to-js'))],
)
async for event in a2a_client.send_message(message):
    print(json.dumps(serialize_event(event)), flush=True)
```

- [ ] **Step 3：编写 Python Server 模式。** 构造使用 `protocol_version='0.3.0'`、`preferred_transport='JSONRPC'` 和动态 JSON-RPC URL 的 `AgentCard`。实现一个 `AgentExecutor`，依次调用 `TaskUpdater.submit()`、`start_work()`、`add_artifact([Part(root=TextPart(text=f'py032:{context.get_user_input()}'))])` 和 `complete()`；通过绑定到 `127.0.0.1:0` 的 socket，用 Uvicorn 承载 `A2AStarletteApplication(...).build()`。
- [ ] **Step 4：编写可自跳过的 Node 互操作测试。** 缺少 `DSH_A2A_PYTHON032` 时使用明确原因跳过。存在时，启动 JavaScript 测试 Bridge 并运行 Python client 模式；断言解析后的终态事件包含 `reply:python-to-js`。随后启动 Python server 模式，读取其 JSON 就绪行，通过 `A2AAgentClient` 调用，并断言 `output === 'py032:js-to-python'`。
- [ ] **Step 5：覆盖 Python 调用 JavaScript 方向的流式、查询和取消。** Client 模式流式发送一条消息，调用 `get_task(TaskQueryParams(id=task_id))`，启动一个由 barrier 阻塞的请求，调用 `cancel_task(TaskIdParams(id=task_id))`，并输出紧凑 JSON verdict，由 Node 逐字段断言。
- [ ] **Step 6：在没有 Python 环境时运行。** 运行普通 Bridge 包测试；预期互操作测试报告一次有意跳过，其余 JavaScript 测试全部通过。
- [ ] **Step 7：增加可复现 PowerShell runner。** 创建或复用 `tmp/a2a-python-v032-venv`，仅在缺少精确包版本时运行 `python -m pip install -r`，把 `DSH_A2A_PYTHON032` 设置为 venv 解释器，构建 Bridge，并只运行 `python-v032-interop.test.mjs`。
- [ ] **Step 8：运行精确版本 smoke。** 运行 `powershell -NoProfile -File business-agent/verify-a2a-python-v032.ps1`；预期两个方向、流式、查询和取消全部通过，并且只打印一次包版本 `0.3.2`。
- [ ] **Step 9：提交互操作切片。** 运行 `git add business-agent/tests/fixtures/a2a-python-v032-* business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs business-agent/verify-a2a-python-v032.ps1 && git commit -m "test(business-agent): verify Python A2A 0.3.2 interop"`。

## Task 6：更新决策记录、运维文档并执行最终验证

**文件：** 修改文件映射中列出的 README 与 Agent Note 双语文件，并刷新每个 `.i18n.yaml` 记录。

**接口：** 文档必须展示直接内网命令和容器环境，但不得声称 `0.0.0.0` 是客户端 URL。

- [ ] **Step 1：更新插件参考文档双语文件。** 记录 v1.0/v0.3 双协议支持、`listener.host`、`listener.port`、运行时 `publicBaseUrl`、预研阶段可选认证、精确 URL、关闭行为和不支持的方法。
- [ ] **Step 2：更新 Bundle 与顶层快速开始双语文件。** 用 Web `127.0.0.1:3081` 加 A2A `127.0.0.1:3082` 替换共享端口描述，并展示以下直接内网命令：

```powershell
powershell -File business-agent\start-dev.ps1 -NoOpen `
  -A2AHost 0.0.0.0 `
  -A2APublicBaseUrl http://192.168.1.10:3082
```

- [ ] **Step 3：更新迁移文档双语文件。** 增加端口 `3082`、容器变量、防火墙可达性、使用 `Invoke-RestMethod` 验证 Card，以及 Docker/Kubernetes 部署必须声明 Service、ingress、负载均衡器或稳定宿主机地址而不是临时容器 IP 的规则。
- [ ] **Step 4：更新现有 implemented Agent Note。** 说明 Bridge 通过官方兼容层提供 v1.0 与 v0.3 JSON-RPC，独立监听器避免暴露共享 Host，运行时拥有声明地址。保留现有备选方案，并增加被否决的共享通配监听器和强制代理方案。
- [ ] **Step 5：刷新所有变更的翻译配对。** 分别针对插件 README、Bundle README、Business Agent README、迁移 README 和 Agent Note 运行 `pnpm run verify-translation-pairing --write <english-path>`，然后对五组文件运行具名检查。
- [ ] **Step 6：运行聚焦产品验证。** 运行 Bridge 构建/测试、Bundle 构建/测试、`business-agent` 纵向测试和 `powershell -NoProfile -File business-agent/verify-a2a-python-v032.ps1`；预期所有不依赖网络的检查和精确 Python smoke 通过。
- [ ] **Step 7：验证模型可见工具未变化。** 运行 `pnpm run test:snapshot -- -t business-a2a-call`；由于工具 schema 和输出保持不变，预期现有快照无需重新录制即可通过。
- [ ] **Step 8：使用 `dsh-pre-push-checks` 选择并运行出站检查。** 包括聚焦 typecheck/lint/docs 命令、`pnpm run test:docs`、`pnpm run doc-sync` 和 `git diff --check`；只记录实际执行的命令，并区分宿主机限制与产品失败。
- [ ] **Step 9：检查完整 diff。** 确认提交集合中没有 `packages/`、`apps/`、凭据、固定部署 IP、虚拟环境、`lib/` 输出或无关用户改动。
- [ ] **Step 10：提交文档与决策记录。** 运行 `git add business-agent .agents/notes/implemented/feature/2026-09-20-a2a-bridge.* && git commit -m "docs(business-agent): document A2A compatibility deployment"`。

## 完成条件

只有在以下条件全部满足时工作才算完成：精确的 Python `a2a-sdk==0.3.2` smoke 双向通过；v1.0 集成仍选择 v1 方法；另一台机器能够访问独立 A2A Card 与 JSON-RPC URL，且 DSH Web 监听器不被暴露；修改 `A2A_PUBLIC_BASE_URL` 无需重新构建即可改变声明地址；绑定失败与流式关闭测试通过；所有聚焦产品、快照、文档和出站检查通过，或存在单独报告的宿主机限制；最终 diff 只涉及 `business-agent/`、现有 A2A Agent Note triplet 和两个 Superpowers 文档 triplet。
