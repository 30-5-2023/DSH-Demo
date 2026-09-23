# A2A v0.3 Input-Required 交互设计

[English](2026-09-23-a2a-input-required-interaction-design.md) | 中文

设计状态：已于 2026-09-23 批准进入实现规划。

## 摘要

当 DSH Session 调用 `ask_user_question` 时，Business Agent 可以暂停入站 A2A v0.3 Task，通过 `input-required` 暴露问题和选项，并在调用方通过同一 Task 回答后恢复原模型回合。状态 Message 同时包含便于人类阅读的 TextPart 和带版本的 DataPart，因此通用 A2A 客户端可以使用自然语言回答，而了解 DSH 约定的客户端可以保留结构化选项。`tasks/get`、阻塞请求和流式请求公开相同的持久化 Task 状态。进程重启无法重建内存中的工具调用，因此等待中的 Task 会明确失败，而不会伪装成可以恢复。

本设计扩展现有的 [A2A Bridge 设计](2026-09-20-a2a-bridge-design.zh.md)、[A2A v0.3 兼容与局域网监听器设计](2026-09-21-a2a-v03-lan-compatibility-design.zh.md)和 [A2A v0.3 文件 Artifact 设计](2026-09-22-a2a-v03-file-artifacts-design.zh.md)。仅当中断 Task、问题 Message、续接输入和出站交互结果与这些文档不同时，本设计取代对应内容。

## 目录

- [目标](#goals)
- [约束](#constraints)
- [选定方案](#selected-approach)
- [运行时流程](#runtime-flow)
- [问题 Message](#question-message)
- [回答 Message](#answer-message)
- [续接与 Task 历史](#continuation-and-task-history)
- [Task 查询与流式传输](#task-queries-and-streaming)
- [出站调用](#outbound-calls)
- [持久化与恢复](#persistence-and-recovery)
- [取消、超时与并发](#cancellation-timeout-and-concurrency)
- [失败](#failures)
- [A2A v0.3 兼容性](#a2a-v03-compatibility)
- [测试](#testing)
- [验收标准](#acceptance-criteria)
- [非目标](#non-goals)
- [参考资料](#references)

<a id="goals"></a>
## 目标

- 当准确的活动 DSH Agent 调用 `ask_user_question` 时，入站 A2A Task 进入 `input-required`。
- Task 状态通过带版本的结构化选项和可读问题表达交互，而不定义私有传输或替换 A2A Part。
- 调用方可以在同一 Task 上发送新的 `message/send` 请求回答问题，并恢复原工具调用和模型回合。
- 产生问题的请求返回后，调用方仍可以通过 `tasks/get` 获取完整的当前问题。
- `call_a2a_agent` 可以把远端交互返回给调用模型，并使用返回的 Task id 发送后续答案。
- 阻塞、流式、轮询、取消、超时、重复投递和进程重启具有确定行为。
- 精确的 Python `a2a-sdk==0.3.2` 互操作测试双向覆盖问题、轮询、回答和最终输出。

<a id="constraints"></a>
## 约束

- 实现保留在 `business-agent/` 下，并使用现有 user-questions capability，不修改 `packages/` 或 `apps/`。
- 验收目标是 Python `a2a-sdk==0.3.2` 使用的 A2A v0.3 JSON-RPC 线上格式。
- A2A 标准化了 `input-required`、Task 状态 Message 和 DataPart 容器，但没有标准化选择表单的 JSON schema。
- 忽略结构化 DataPart 的通用 A2A 对端仍必须能理解并回答 TextPart。
- Bridge 保留 SDK 当前的 v1.0 行为作为回归覆盖，但本次变更不增加 v1.0 交互验收目标。
- 鉴权、授权和公网部署仍在本次预研变更范围之外。
- 暂停的 DSH 工具调用只存在于运行进程中，重启后无法重建。

<a id="selected-approach"></a>
## 选定方案

当 `ask_user_question` 等待答案时，Bridge 保持原 Session 回合存活。A2A 交互管理器把准确的活动 Agent id（也就是 Session id）与活动 A2A Task 关联。当该 Agent 提问时，管理器先持久化并发布 `input-required` Task 状态，然后等待续接 Message。

官方 A2A SDK 观察到 `input-required` 后返回阻塞或流式请求，同时保持 Task 事件总线和原执行器调用存活。后续携带相同 Task id 的 `message/send` 请求进入同一事件总线。执行器校验答案，持久化并发布 `working`，解除等待中的 user-question 请求，然后等待原回合完成。

本设计保留真实的工具续接。收到答案后启动新模型回合的方案会把答案变成新提示词，并让原工具调用无法完成，因此不采用。任意暂停模型工具调用的持久化重建方案依赖当前 Session 运行时尚未提供的可恢复执行检查点，而且业务 fork 不允许修改 Agent Loop，因此不采用。

交互 schema 是标准 DataPart 内的可选应用级约定。配套 TextPart 携带完整问题，Agent Card 不声明必需的 A2A extension。理解该 schema 的对端可以渲染选项，其他对端可以使用普通文本回答。

<a id="runtime-flow"></a>
## 运行时流程

1. `message/send` 创建或恢复 Task，持久化 `submitted`，创建或解析上下文所属 Session，然后持久化 `working`。
2. Session 模型在该 Task 的模型回合中调用 `ask_user_question`。
3. 只有当 `request.agent.id` 匹配活动入站 A2A 执行时，A2A 交互管理器才接受请求；对于其他 Agent 或无作用域请求，它调用 waterfall 的 `next()`。
4. 管理器创建一个待回答交互，把 Agent 问题 Message 追加到 Task 历史，持久化 `input-required`，然后发布状态更新。
5. 当前阻塞响应或事件流返回中断 Task。原 Session 回合继续暂停在 user-question 工具内。
6. 调用方使用相同 `taskId` 发送答案；可以携带 `contextId`，携带时必须匹配。
7. 执行器在普通新 Task 准入前识别活动待回答交互，校验答案，持久化并发布 `working`，然后解析待回答的 user-question 结果。
8. 原 Session 回合继续运行，产生普通文本、数据和文件 Artifact，并把 Task 结算为 `completed` 或其他终态。
9. 后续请求保持连接到 Task 事件总线，直到收到恢复后 Task 的结果。

上下文调度器继续串行化 Session。在本次预研交付中，等待中的交互保留上下文锁和一个 `maxConcurrentContexts` 槽位，因此第二个 Task 不能在同一 Session 中启动并发回合。

<a id="question-message"></a>
## 问题 Message

`input-required` 状态包含一个 Agent Message，其中包括 Task id、context id、唯一 message id、TextPart 和 DataPart。Bridge 在发布状态前把同一个 Message 保存到 Task 历史。

TextPart 渲染每个问题 id、问题、可选 detail，以及选项标签和描述。它不要求客户端支持 Markdown，并包含文本客户端回答所需的全部信息。

DataPart 使用以下载荷：

```json
{
  "schema": "urn:deepseek-harness:a2a:input-required:v1",
  "questions": [
    {
      "id": "environment",
      "question": "Select the target environment",
      "header": "Environment",
      "detail": "The deployment uses the selected environment immediately.",
      "options": [
        { "label": "Development", "description": "Deploy to the development environment." },
        { "label": "Test", "description": "Deploy to the test environment." }
      ],
      "multiSelect": false
    }
  ]
}
```

Bridge 保留 user-questions 请求提供的 `id`、`question`、可选 `header`、可选 `detail`、可选 `options`、可选 `multiSelect` 和可选展示 `intent`。只有面向消费者的字段含义或校验规则发生变化时，schema 版本才变化。

回答无效后，同一 DataPart 还包含 `error` 对象，其中使用稳定代码 `A2A_INTERACTION_INVALID_RESPONSE` 和安全消息。原问题继续保留，使调用方无需再次查询 Task 就能纠正回答。

<a id="answer-message"></a>
## 回答 Message

结构化调用方发送 user Message，其 DataPart 使用以下载荷：

```json
{
  "schema": "urn:deepseek-harness:a2a:input-response:v1",
  "answers": [
    {
      "id": "environment",
      "selected": ["Test"]
    }
  ]
}
```

问题 id 必须唯一，并且必须匹配待回答交互。结构化响应必须恰好覆盖每个待回答问题一次。每个选中标签必须属于该问题的选项，未设置 `multiSelect: true` 的问题最多接受一个选中标签。没有选项的问题使用非空 `custom` 值；当调用方提供自由填写替代项时，有选项的问题也可以携带 `custom` 文本。

如果不存在已识别的响应 DataPart，Bridge 接受拼接后的非空 TextPart 内容作为兼容答案。对于一个待回答问题，该内容成为问题的 `custom` 值。对于多个问题，该内容成为第一个问题的 `custom` 值，使恢复后的模型能够解释组合回答，并在信息仍然缺失时再次提问。

当存在已识别的响应 DataPart 时，它具有权威性。无效结构化数据不会静默回退到相邻文本，因为该行为会掩盖集成错误。

FilePart 不能回答 `ask_user_question` 请求。Bridge 可以在普通 A2A 输入和输出路径中物化文件，但既没有已识别响应 DataPart、也没有非空文本的续接仍保持 `input-required`。

<a id="continuation-and-task-history"></a>
## 续接与 Task 历史

调用方使用 `message/send` 和现有 `taskId` 继续中断 Task。调用方可以省略 `contextId`，服务器从 Task 推断。两个值同时存在时，现有 SDK 会拒绝 context 不匹配。

请求处理器在执行器处理前把调用方答案 Message 追加到 Task 历史。Task 进入 `input-required` 时已经追加问题 Message，因此完成后的 Task 历史会记录初始请求、Agent 问题、调用方答案，以及历史长度限制允许的后续回合。

第一个合法答案以原子方式取得待回答交互。相同 message id 的重试不会重复解析工具调用。答案被接受后的并发续接只观察当前 `working` 或终态 Task，并连接到它的结果，不再注入另一个答案。

无效答案产生另一个 `input-required` 状态 Message，其中包含新 message id、校验错误和相同问题。原待回答工具调用继续保持未解析。

<a id="task-queries-and-streaming"></a>
## Task 查询与流式传输

JSON-RPC 客户端使用 `tasks/get` 查询当前状态；A2A v0.3 没有定义 `message/get`。启用该传输时，对应的 REST 接口是 `GET /v1/tasks/{id}`。

Repository 在发布每个状态变更前持久化完整 Task。因此交互期间的查询会返回 `status.state: "input-required"`，以及包含 TextPart、DataPart、Task id、context id 和 message id 的完整 `status.message`。历史长度限制只影响 Task 历史，不会移除当前状态 Message。

`message/stream` 发出相同的持久化状态更新，并在 `input-required` 时关闭该响应流。调用方随后可以通过 `message/send` 继续，也可以通过受支持的 Task 订阅操作重新订阅。

阻塞、流式和轮询客户端观察到等价的 Task 语义。这些路径都不会把问题转换为 Artifact，因为澄清属于继续任务所需的通信，而不是 Task 结果。

<a id="outbound-calls"></a>
## 出站调用

`call_a2a_agent` 增加可选 `task_id` 输入。该字段存在时，工具设置出站 Message Task id，并保持 `context_id` 可选，从而符合 A2A 续接规则。JSON `message` 转为 DataPart，字符串 `message` 转为 TextPart，因此调用模型可以发送带版本的结构化答案或自然语言答案。

远端 Task 返回 `input-required` 时，结果增加可选 `interaction` 对象：

```json
{
  "context_id": "context-1",
  "task_id": "task-1",
  "state": "input-required",
  "interaction": {
    "text": "Select the target environment: Development or Test.",
    "data": [
      {
        "schema": "urn:deepseek-harness:a2a:input-required:v1",
        "questions": []
      }
    ]
  }
}
```

`interaction.text` 按顺序拼接远端 TextPart。`interaction.data` 按顺序保留远端 DataPart 值。状态 Message 中的 FilePart 使用现有的有界物化路径，并出现在结果的 `files` 数组中。

流式收集在 `input-required` 和终态时都会停止。同步 Task 解析与流式聚合都会读取 `status.message`；对端请求输入后，两者都不会继续等待 `completed`。

最终 Task Artifact 继续使用 `output` 和 `files`。独立的 `interaction` 字段可以避免把问题误认为完成输出。

<a id="persistence-and-recovery"></a>
## 持久化与恢复

Task repository 保存完整的 `input-required` Task，包括当前状态 Message 和历史。因此原 HTTP 响应返回后，只要进程仍存活，`tasks/get` 就能工作。

待回答 user-question 解析器、活动 Agent、Session 回合和事件总线仍由进程拥有。启动恢复把现有中断 Task 扫描扩展到 `input-required`；它把这些 Task 改为 `failed` 并设置 `A2A_HOST_INTERRUPTED`，因为不存在能够接收后续答案的活动工具调用。

恢复会保留终态 Task 及其 Artifact。它不会在重启后继续宣告过期问题，也不会接受无法到达原模型回合的答案。

<a id="cancellation-timeout-and-concurrency"></a>
## 取消、超时与并发

`tasks/cancel` 中止待回答 user-question 等待，只取消 Session 回合一次，并持久化 `canceled`。管理器仅在执行完成后移除 Session 和 Task 关联，因此取消与回答竞态只有一个终态胜者。

现有 `requestTimeoutMs` 限制完整入站 Session 回合，包括停留在 `input-required` 的时间。超时会取消 Session，并使用 `A2A_EXECUTION_TIMEOUT` 持久化 `failed`。需要更长人工响应窗口的部署可以在当前限制内把现有已校验配置字段设为更大值。

一个 Task 最多有一个待回答交互。同一执行产生第二个并发问题时，管理器把它作为回合失败拒绝，因为一个续接 Message 无法标识它要回答哪个暂停工具调用。

等待中的执行保留一个上下文调度器槽位。在保留 Session 独占锁的同时释放全局容量需要调度器暂停设计；该能力推迟到实测等待量证明其必要性后处理。

<a id="failures"></a>
## 失败

无效结构化答案属于可恢复交互错误。Task 保持 `input-required`，状态 Message 包含 `A2A_INTERACTION_INVALID_RESPONSE`，调用方可以再次回答。

未知 Task id 使用 SDK 的 `TaskNotFoundError`。Context 不匹配使用 SDK 的 malformed-request 错误。发送到终态 Task 的续接使用 SDK 的 `UnsupportedOperationError`。

如果已持久化的 `input-required` Task 没有活动管理器记录，则续接会安全失败。正常启动会把该状态转为 `failed`；狭窄的启动竞态也会拒绝答案，而不会启动替代模型回合。

内部异常、远端响应正文、Session 细节和堆栈跟踪不会进入模型可见或 A2A 可见诊断。现有安全失败转换继续作为终态错误的权威实现。

<a id="a2a-v03-compatibility"></a>
## A2A v0.3 兼容性

Bridge 继续使用官方 `@a2a-js/sdk` 内部类型实现执行器，并启用 SDK 的 v0.3 兼容适配器。适配器发出 v0.3 JSON-RPC 方法名、`input-required` 等小写 Task 状态，以及使用 `kind` 区分的 TextPart、DataPart 和 FilePart 值。

Python `a2a-sdk==0.3.2` 通过标准模型解析状态 Message 和 DataPart。`schema` 值及其嵌套字段属于应用数据，不是替代协议模型。

[ryubyte/dsh-a2a](https://github.com/ryubyte/dsh-a2a) 参考实现提供三个行为参考：中断状态返回给调用方、状态 Message 保持可见，以及后续调用可以指向现有 Task。它的服务端没有发布并恢复完整的 input-required 工具交互，其出站适配器也不保留结构化选项或 Task id，因此本实现不导入它的源代码或私有协议类型。

<a id="testing"></a>
## 测试

编解码单元测试覆盖问题渲染、schema 编码、结构化校验、文本回退、多个问题、单选与多选、自定义回答、未知 id、重复 id、缺失回答和不支持的选项。

执行器测试使用真实 user-questions waterfall 和受控 Session 回合。测试验证只有准确的 A2A Agent 被拦截、原工具 Promise 保持等待、合法续接只解析一次，以及同一模型回合产生最终 Artifact。

服务端集成测试覆盖阻塞与流式 `input-required`、`tasks/get`、完整状态 Message、历史、结构化与文本续接、无效回答重试、重复投递、并发投递、取消、超时和重启恢复。

出站客户端测试覆盖同步与流式中断 Task、状态 Message 收集、`task_id` 续接、推断 context id、结构化 DataPart 答案、文本答案和状态 Message FilePart 物化。

现有 Python 互操作 fixture 继续固定使用精确的 `a2a-sdk==0.3.2`。Python 到 DSH 的测试接收 input-required Task，通过 `tasks/get` 获取它，提交结构化和文本答案，并观察最终输出。DSH 到 Python 的测试公开 Python input-required Task，并验证 `call_a2a_agent` 返回交互且使用同一 Task id 恢复它。

`business-a2a-call` 无密钥 Session 快照记录新增工具输入和结果字段。现有文本、数据、文件、v0.3 和 v1.0 回归测试继续保留。

文档更新覆盖 package README pair、Business Agent 快速开始、部署与迁移指导、模型可见工具字段、超时行为、重启行为，以及 `tasks/get` 与不存在的 `message/get` 之间的区别。同一变更中的 Agent Note 负责记录已实现理由和已交付验证证据。

<a id="acceptance-criteria"></a>
## 验收标准

- 入站 DSH Agent 问题产生持久化 v0.3 Task，其中 `state: "input-required"`，并包含 Agent 状态 Message、可读文本和带版本的问题 DataPart。
- 原阻塞或流式请求在 `input-required` 时返回，随后 `tasks/get` 能获取相同的完整状态 Message。
- 同一 Task 上的结构化答案解析原 `ask_user_question` 调用，并完成原模型回合，不创建另一个 Session prompt。
- 自然语言 TextPart 答案可以恢复单个问题，并可作为组合式多问题回答使用。
- 无效答案保持 Task 中断，保留问题，并返回稳定且安全的校验错误。
- `call_a2a_agent` 返回远端交互、接受 `task_id`，并通过流式与非流式传输继续远端 Task。
- 取消、超时、重复答案、并发答案和重启产生文档规定的单一胜者状态，不泄漏等待或重复工具结果。
- 精确的 Python `a2a-sdk==0.3.2` 双向通过测试，包括通过 `tasks/get` 轮询。
- 现有文本、数据和文件行为保持可用，现有 v1.0 测试继续作为回归覆盖通过。

<a id="non-goals"></a>
## 非目标

本变更不标准化 A2A 表单 schema，不要求私有 extension，不增加鉴权，不增加本地人工 UI，不跨进程重启恢复暂停工具调用，不在等待时释放调度器容量，不把 FilePart 作为问题答案，也不增加 v1.0 交互验收目标。它不修改共享 DSH Web listener、Agent Loop、Session 持久化格式或 user-questions service。

<a id="references"></a>
## 参考资料

- [A2A v0.3 规范](https://a2a-protocol.org/v0.3.0/specification/)
- [A2A Python SDK 0.3.2](https://github.com/a2aproject/a2a-python/tree/v0.3.2)
- [A2A JavaScript SDK v0.3 兼容指南](https://github.com/a2aproject/a2a-js/blob/main/docs/compatibility-v0_3.md)
- [DSH user-questions 服务](../../../packages/interaction/user-questions/README.zh.md)
- [DSH ask-user 工具](../../../packages/interaction/tool-ask-user/README.zh.md)
