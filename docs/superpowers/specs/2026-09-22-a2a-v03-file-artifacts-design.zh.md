# A2A v0.3 文件产物设计

[English](2026-09-22-a2a-v03-file-artifacts-design.md) | 中文

设计状态：等待书面设计审批。

## 摘要

Business Agent 通过 Python `a2a-sdk==0.3.2` 使用的 A2A v0.3 线格式接收和返回文件。小文件以内联 `FileWithBytes` 传输，大文件通过 Bridge 托管的 `FileWithUri` URL 传输。每个接收或发布的文件都会先快照到现有 DSH attachment 服务，因此 Session 输入、远端输出、重试和下载引用的是稳定字节，而不是可变的源路径。

本设计扩展现有的 [A2A Bridge 设计](2026-09-20-a2a-bridge-design.zh.md)和 [A2A v0.3 兼容与内网监听设计](2026-09-21-a2a-v03-lan-compatibility-design.zh.md)。只有文件 Part、文件发布、文件下载路由、配置和相关测试发生冲突时，本设计取代原文。

## 目录

- [目标](#goals)
- [约束](#constraints)
- [选定方案](#selected-approach)
- [A2A v0.3 映射](#a2a-v03-mapping)
- [入站文件](#inbound-files)
- [发布 Agent 输出文件](#publishing-agent-output-files)
- [出站调用](#outbound-calls)
- [下载端点](#download-endpoint)
- [持久化与生命周期](#persistence-and-lifecycle)
- [配置](#configuration)
- [失败与安全](#failures-and-security)
- [测试](#testing)
- [验收标准](#acceptance-criteria)
- [非目标](#non-goals)
- [参考资料](#references)

<a id="goals"></a>
## 目标

- 使用 `a2a-sdk==0.3.2` 的 Python 客户端能够把 `FileWithBytes` 和 `FileWithUri` Part 与文本、数据 Part 一起发送给 Business Agent。
- Business Agent 能够把生成的本地文件发布为 A2A v0.3 输出 Artifact，不扫描工作区，也不解析自然语言回复中的文件路径。
- `call_a2a_agent` 能够把本地文件发送给 Python `a2a-sdk==0.3.2` Agent，并把该 Agent 返回的文件输出落地到本机。
- 小文件传输保持自包含；大文件通过 URL 流式传输，不把整个文件扩展为进程内存或模型可见工具输出中的 base64。
- 在同步和流式调用中，文件字节、文件名、媒体类型、Part 顺序、Task 归属、取消和配置的大小限制都保持确定。

<a id="constraints"></a>
## 约束

- 实现全部位于 `business-agent/`，只消费现有服务，不修改 `packages/` 或 `apps/`。
- 验收目标是 Python `a2a-sdk==0.3.2` 实现的 A2A v0.3；v1.0 文件互操作不属于本次改动的验收要求。
- 现有文本、数据、v0.3 和 v1.0 行为继续可用。在把新增文件测试和文档限定到 v0.3 的同时，Bridge 不会主动移除 SDK 当前的 v1.0 兼容能力。
- 服务端无法读取调用方本地文件系统路径。远端调用方必须传输字节，或提供服务端能够获取的 HTTP(S) URI。
- 预研部署不要求用户认证，但不得暴露可预测的文件 URL、任意本地路径、无界下载或无关的 DSH Web 路由。
- 文件使用现有 DSH attachment 服务作为持久字节存储。Bridge 不创建第二套文件仓库。

<a id="selected-approach"></a>
## 选定方案

Bridge 使用官方 `@a2a-js/sdk` v0.3 兼容转换处理线类型。v0.3 `FileWithBytes` 在内部作为 raw Part 到达，v0.3 `FileWithUri` 在内部作为 URL Part 到达。反向转换会发出对应的 v0.3 FilePart，因此 Bridge 围绕这些核心 Part 变体增加准入、存储、发布和落地能力，不维护私有 A2A 编解码器。

每个文件都经过一个规范快照步骤。入站字节或获取的 URI 内容、为出站调用选择的本地文件，以及被服务 Agent 明确发布的文件，都会流式写入 `ctx.attachments.saveFileStream`。后续读取使用 `ctx.attachments.readFileStream`，在保持背压和取消语义的同时校验存储长度和摘要。

混合传输规则以存储字节数为依据。字节数不超过 `inlineFileMaxBytes` 的文件以 `FileWithBytes` 发出；更大的文件通过独立 A2A 监听器托管的 `FileWithUri` 发出。分支选择不依赖文件名、媒体类型、调用方身份或模型判断。

不采用自动扫描工作区，因为它可能泄露无关文件，也无法可靠地区分生成产物和临时状态。不采用所有文件都返回 base64，因为 base64 会增大负载并要求处理完整 JSON 负载。不采用只返回服务端本地路径，因为远端调用方无法引用这些路径。

<a id="a2a-v03-mapping"></a>
## A2A v0.3 映射

| A2A v0.3 值 | SDK 内部 Part | Bridge 处理 |
| --- | --- | --- |
| `FilePart(file.bytes, file.name, file.mimeType)` | 带文件名和媒体类型的 raw 字节 | 校验、快照，并作为 DSH 文件输入或输出接收 |
| `FilePart(file.uri, file.name, file.mimeType)` | 带文件名和媒体类型的 URL | 按 URI 策略获取、快照，并作为 DSH 文件输入或输出接收 |
| Bridge 内联文件 | 带文件名和媒体类型的 raw 字节 | SDK 发出 v0.3 `FileWithBytes` |
| Bridge 托管文件 | 带文件名和媒体类型的 URL | SDK 发出 v0.3 `FileWithUri` |

Bridge 在构建 Session prompt 内容和收集远端输出时保留文本、数据和文件 Part 的顺序。文件名只作为显示元数据使用，在存储或响应头中会缩减为安全的叶名称；它绝不选择文件系统目标位置。

一个 v0.3 文件必须且只能包含字节或 URI 之一。缺少内容、内容冲突、base64 格式错误、文件名为空或不安全、媒体类型无效，或者内容超过 `maxFileBytes` 时，请求会以稳定 Bridge 错误失败，而不是丢弃该文件。

<a id="inbound-files"></a>
## 入站文件

对于 `FileWithBytes`，Bridge 在线协议入口校验规范 base64，通过增量解码或 attachment 准入 API 解码，执行 `maxFileBytes` 限制，并保存精确的解码字节。配置的内联阈值只控制 Bridge 发出内容的方式；只要 HTTP 请求和文件限制都允许，入站对端可以发送更大的内联值。

对于入站 `FileWithUri`，Bridge 只接受不含凭据和 fragment 的绝对 HTTP(S) URL，并要求源 origin 出现在 `fileUrlAllowedOrigins` 中。因此，空列表会禁用入站 URI 获取，但仍允许字节文件。重定向次数受限，每个重定向目标都重新校验，拒绝 HTTPS 到 HTTP 降级，并在响应流超过 `maxFileBytes` 时立即停止。

Bridge 通过现有 file-upload 服务把已存储文件上传到目标 Session，并在原始 Part 位置用文件内容块 prompt Session。即使媒体类型以 `image/` 开头，通用文件仍作为通用文件输入；本次改动保证精确的 A2A 文件语义，不增加面向视觉能力的图片规范化。

一条消息的准入保持全有或全无。Bridge 在 prompt Session 前准备全部文件并校验全部 Part；任一成员失败都不会发布部分 prompt。取消操作会中止 URI 获取、attachment 写入和 Session 上传工作。

<a id="publishing-agent-output-files"></a>
## 发布 Agent 输出文件

插件注册模型可见的 `publish_a2a_file` 工具，参数为 `path`、可选的 `name` 和可选的 `media_type`。该工具是 DSH 内部能力，不是 A2A 协议扩展。只有当前 Session turn 属于一个活动的入站 A2A Task 时，工具才能成功，并把生成的 attachment 引用关联到该 Task。

工具相对当前 Session 工作区解析相对路径。绝对路径只有位于 Session 工作区或配置的 `publishFileAllowedRoots` 条目内时才接受。解析后的目标必须是常规文件，不得通过逃逸的符号链接穿越根目录，并且在读取前后的文件身份检查之间不得发生变化。

发布操作立即通过 `saveFileStream` 快照文件；之后编辑或删除源路径都不会改变 Artifact。重复发布会为当前 Task 创建有序文件条目。并发 Task 和 Session 不能观察或发布彼此待处理的条目。

Task 成功完成时，executor 在该 Task 已有的文本或数据输出之后，把已发布文件加入输出 Artifact。大小不超过 `inlineFileMaxBytes` 的文件变成 raw Part；更大的文件获得托管 URL 并变成 URL Part。失败、取消、拒绝或超时的 Task 不会暴露未发布或仅部分存储的文件输出。

<a id="outbound-calls"></a>
## 出站调用

`call_a2a_agent` 增加可选的 `files` 数组。每个条目包含 `path` 以及可选的 `name` 和 `mime_type`；现有 `message`、`context_id`、`stream`、`accepted_output_mode` 和 `timeout_ms` 字段保持当前行为。

本地出站路径遵循与 `publish_a2a_file` 相同的允许根目录、常规文件、符号链接、大小和稳定读取检查。每个接受的文件都在网络分派前完成快照。出站消息把现有文本或数据 Part 放在首位，并按声明的数组顺序追加文件 Part。

小型出站文件使用 raw Part，因此成为 v0.3 `FileWithBytes`。大型出站文件使用调用方 Bridge 托管的 URL，因此成为 v0.3 `FileWithUri`。大型文件调用要求独立监听器和可访问的 `publicBaseUrl`；Bridge 无法生成远端可达 URI 时，配置或调用准备会明确失败。

结果增加有序 `files` 数组，不嵌入文件字节。对于每个远端 raw 或 URL 输出 Part，Bridge 执行相同的大小策略；远端 URL 可以使用已解析 Agent Card 的 origin，或 `fileUrlAllowedOrigins` 中的 origin。Bridge 把字节快照到 DSH attachment，落地只读本地文件投影，并返回 `path`、`name`、`mime_type`、`bytes` 和 `artifact_id`。文本和 JSON 继续放在 `output` 中；不支持的 Part 变体会失败，而不是静默消失。

同步调用从最终 Message 或 Task Artifact 收集远端输出；流式调用从组装后的 Artifact 流收集输出。Artifact 的 append 和 replace 语义继续由传输层负责，文件只从最终组装的 Part 序列落地。

<a id="download-endpoint"></a>
## 下载端点

独立 A2A 监听器增加 `<route>/files/<token>` 的 `GET` 和 `HEAD`，默认路径为 `/a2a/files/<token>`。共享 DSH Web 监听器不包含该路由。`GET` 以背压方式流式返回经过校验的 attachment 分块；`HEAD` 返回相同元数据但不返回内容。本次交付不支持字节范围请求。

`<token>` 是使用密码学随机数生成、不可枚举的 capability 值。其持久记录包含 attachment 引用、所属 Task id、安全文件名、媒体类型、字节数、创建时间和过期时间。URL 由 `publicBaseUrl` 生成；存储配置中不会出现 `0.0.0.0` 或写死的物理机、容器地址。

成功响应设置 `Content-Type`、`Content-Length`、安全的 `Content-Disposition` 和 `X-Content-Type-Options: nosniff`。未知或已撤销 token 返回 404。已过期 token 返回 410。其他路由继续返回 404，绝不落入 DSH Web handler。

在配置的预研部署中，token 本身授权下载。它只适用于可信网络评估：日志和模型输出不得无必要地打印 token，端点不发出重定向，未来经过认证的部署需要独立授权设计。

<a id="persistence-and-lifecycle"></a>
## 持久化与生命周期

文件链接记录使用 Bridge 现有 storage domain，因此进程重启后，有效下载仍可持续到过期时间。Attachment 字节仍由 attachment 服务拥有；删除或过期链接会撤销 Bridge 访问能力，但不会直接删除共享的内容寻址 attachment。

Task 发布记录会在 Task 进入 completed 状态前写入，因此返回的 URI 不会指向缺失元数据。链接持久化失败时，Task 完成操作会失败，而不是返回不可用的 Artifact。部分启动和关闭使用现有 Bridge 生命周期顺序，并在释放存储前关闭已接收的下载流。

过期记录在启动以及创建或访问链接时择机删除。清理有界并且幂等。Attachment provider 继续负责 attachment 保留和完整性；`fileRetentionMs` 只控制链接有效期。

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `inlineFileMaxBytes` | 1 MiB | 以 v0.3 `FileWithBytes` 发出的最大存储文件 |
| `maxFileBytes` | 256 MiB | 接收、获取、发布、发送或落地文件的最大大小 |
| `fileRetentionMs` | 24 小时 | 托管文件 capability URL 的有效期 |
| `fileUrlAllowedOrigins` | `[]` | 入站 URI 文件允许的精确 HTTP(S) origin，以及远端输出 URI 文件允许的额外 origin |
| `publishFileAllowedRoots` | `[]` | 除活动 Session 工作区外允许的额外绝对本地根目录 |
| `maxRequestBytes` | 2 MiB | 现有 JSON-RPC body 限制，从 1 MiB 上调以容纳默认内联文件及 base64、JSON 开销 |

所有值都是 Cordis 配置字段，因为它们随部署变化。`inlineFileMaxBytes` 必须为正，并且不得大于 `maxFileBytes`。Resolver 还会校验 `maxRequestBytes` 能够容纳经过 base64 和 JSON 开销后的最坏情况内联文件；无效组合在插件加载时失败。

`publicBaseUrl` 继续作为唯一声明地址。Bridge 可能发出托管 URI 时，必须启用独立监听器。Agent Card 输入和输出模式在配置的文本与 JSON 模式之外增加 `application/octet-stream`。

插件在加载时要求 attachment 存储和 Session file-upload 服务。缺少服务或 provider 不支持通用文件流时，会在 A2A 端点可用前明确失败。

<a id="failures-and-security"></a>
## 失败与安全

稳定 Bridge 失败会区分文件数据格式错误、URI 被拒绝、重定向超限、协议降级、获取超时、内容过大、媒体元数据不支持、本地路径被拒绝、本地文件不稳定、缺少 attachment 服务、链接过期和远端文件落地失败。协议 handler 把它们映射为对应版本的 A2A 失败；模型可见工具返回简洁诊断，不包含远端响应正文、本地存储内部信息或 token。

所有网络和文件系统传输都采用流式处理，支持取消并明确统计字节。错误的 `Content-Length` 不能绕过实际字节限制。每次请求和重定向前都执行 URI 校验，并对实际打开文件使用的解析目标执行本地路径校验。

初始无认证部署假定可信内网。Capability token 可以降低意外发现风险，但不能替代认证、授权、TLS、出站控制、恶意软件扫描、配额或审计策略。在可信预研网络之外开放监听器前，仍必须补充这些控制。

<a id="testing"></a>
## 测试

聚焦单元测试覆盖 v0.3 raw 与 URL Part 映射、规范 base64、文件名和媒体类型校验、Part 顺序、内联阈值选择、允许 origin 与重定向、稳定本地文件读取、token 生成、过期、响应头、重启恢复、输出收集、并发隔离和每一种稳定失败类别。

集成测试使用真实 attachment 和 file-upload 服务，验证入站 Session 准入、明确 Task 发布、托管下载、出站快照和远端输出落地各路径的精确字节与 SHA-256 摘要。测试在首次超限分块处停止过大流，并验证取消会释放 reader、fetch 和 HTTP 响应。

隔离的 Python 环境固定使用真实 `a2a-sdk==0.3.2`。Python 到 DSH 用例发送 `FileWithBytes`、`FileWithUri` 和混合文本、数据、文件消息。DSH 到 Python 用例发送小型内联和大型托管本地文件。随后 Python 接收发布的小型和大型 Task Artifact，下载 URI 文件，并校验字节、名称、MIME 类型、顺序、Task id 和终态。

现有 v0.3 文本和 JSON 测试继续保留。现有 v1.0 测试继续作为回归覆盖，但本次改动不声明或增加 v1.0 文件验收。实现会同步更新包 README 双语文档、Business Agent 快速开始、bundle 配置、模型可见工具快照，以及同一改动中的一份 Agent Note。

<a id="acceptance-criteria"></a>
## 验收标准

- Python `a2a-sdk==0.3.2` 把内联和 URI 文件发送给 Business Agent，Session 按原始 Part 顺序接收精确的已存储文件。
- `publish_a2a_file` 在完成的 v0.3 Task 中，把生成的小文件返回为 `FileWithBytes`，把生成的大文件返回为可下载的 `FileWithUri`。
- `call_a2a_agent` 把本地小文件和大文件发送给 Python 0.3.2 Agent，并以包含元数据的本地落地路径返回远端文件输出，绝不嵌入文件字节。
- 每次往返都保留精确字节、安全文件名、媒体类型、Artifact 顺序、Task 归属、超时和取消行为。
- 托管 URL 在进程重启后持续有效直到过期，过期后返回 410，并且地址来自运行时 `publicBaseUrl`，而不是写死 IP。
- 文件过大、格式错误、origin 不允许、路径逃逸、符号链接逃逸、读取期间变化、链接过期和类型不支持等情况都会明确失败，不产生部分 Session prompt，也不静默省略 Part。
- 现有 A2A v0.3 文本与 JSON 行为和现有 A2A v1.0 回归测试继续通过。

<a id="non-goals"></a>
## 非目标

本次改动不增加 v1.0 文件验收，不直接访问调用方本地路径，不扫描工作区，不支持断点续传或范围下载，不进行公网加固、病毒扫描、内容转换、对象存储 URL、文件预览或自动删除 attachment。它不会修改共享 DSH Web 监听器，也不会引入第二套 attachment 存储。

<a id="references"></a>
## 参考资料

- [A2A Python SDK 0.3.2 types](https://github.com/a2aproject/a2a-python/blob/v0.3.2/src/a2a/types.py)
- [A2A JavaScript SDK v0.3 compatibility guide](https://github.com/a2aproject/a2a-js/blob/main/docs/compatibility-v0_3.md)
- [DSH attachment 服务](../../../packages/attachment/attachment/README.zh.md)
- [DSH 本地 attachment provider](../../../packages/attachment/attachment-local/README.zh.md)
