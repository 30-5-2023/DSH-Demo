# 业务 Agent 开发计划

## 摘要

本计划把业务 Agent 拆成严格串行的开发任务。每个任务只交付一个可独立构建、可独立验证的增量；验收未通过时必须停留在当前任务，不得开始下一任务。Task 0 至 Task 6 只打通最小闭环，Task 6 是 MVP 里程碑；持久化、完整异常处置、交付件、安全和多工单体验在闭环通过后分别强化。产品架构与行为约束以 [DESIGN.md](DESIGN.md) 为准，本文件只负责实施顺序、任务范围和验收标准。

## 目录

- [执行规则](#执行规则)
- [存量代码处置](#存量代码处置)
- [任务总览](#任务总览)
- [Task 0：关闭产品决策并冻结 MVP 契约](#task-0关闭产品决策并冻结-mvp-契约)
- [Task 1：重建最小工单服务](#task-1重建最小工单服务)
- [Task 2：建立插件与 Profile 骨架](#task-2建立插件与-profile-骨架)
- [Task 3：以原生工具接入 MCP](#task-3以原生工具接入-mcp)
- [Task 4：接入最小唤醒器](#task-4接入最小唤醒器)
- [Task 5：接入实时只读右栏](#task-5接入实时只读右栏)
- [Task 6：锁定 MVP 端到端闭环](#task-6锁定-mvp-端到端闭环)
- [Task 7：持久化与重启恢复](#task-7持久化与重启恢复)
- [Task 8：异常处置与幂等写](#task-8异常处置与幂等写)
- [Task 9：交付件读取](#task-9交付件读取)
- [Task 10：认证、CORS 与部署配置](#task-10认证cors-与部署配置)
- [Task 11：多工单与完整产品状态](#task-11多工单与完整产品状态)
- [Task 12：生产业务系统适配](#task-12生产业务系统适配)
- [Dev Note](#dev-note)

## 执行规则

1. **严格串行。** 一个任务只有在构建、自动验证、手工验收和变更检查全部通过后才算完成。上一任务未通过，不得开始下一任务。
2. **一个任务一个可审查增量。** 每个任务单独提交或单独 PR，不夹带后续任务的半成品。后续任务以已验收任务的提交为基线。
3. **先验证最小闭环。** Task 0 至 Task 6 不加入生产强化能力，除非缺少它会让闭环无法被正确验证。Task 6 通过后，MVP 才成立。
4. **每项都有失败证据。** 自动验证既覆盖成功路径，也至少覆盖一个与本任务直接相关的拒绝或恢复路径。测试失败时修复当前任务，不降低断言，也不跳过验证。
5. **不改底座。** 实现只落在 `business-agent/` 的插件、Bundle 和 Profile patch 中，不修改 `packages/` 或 `apps/`。若现有扩展点确实不足，先停下并形成明确问题，不能直接修改 agent loop。
6. **按真实入口验证。** Node 应用只通过 `dsh` Profile 启动。服务可以独立启动；DSH 插件必须通过 Bundle/Profile 组合验证，不能用测试专用的内联应用树代替启动验收。
7. **控制文档和测试随代码更新。** 每个非平凡实现任务同时新增或更新 Agent Note、包 README、必要的 JSDoc 和测试。模型或产品用户可见行为同时更新无密钥快照；GUI 任务按仓库要求录制真实流程 GIF。
8. **记录验收证据。** 每个任务的 PR 或提交说明只记录实际运行的命令、结果和手工观察，不把计划中的命令写成已经通过。

建议的业务扩展目录如下；Task 0 可以调整名称，但 Task 1 开始后不再随意搬动：

```text
business-agent/
  bundle/                    业务 Bundle 与 cordis.patch.yml
  plugins/
    workorder-host/          唤醒、绑定和 Host 侧远程能力
    workorder-ui/            右栏只读页面
  workorder-service/         独立业务服务
  tests/                     跨包和端到端场景
```

所有新增 npm 包使用 `@deepseek-ai/dsh-` 前缀。每个包提供自己的 `build` 与聚焦测试命令；根构建只作为组合检查，不能替代包级验证。

## 存量代码处置

| 路径 | 现在怎么处理 | 何时可以删除或替换 |
|---|---|---|
| `workorder-service/` | 已按 MVP 契约重建为唯一运行时 | 后续任务在同一服务上演进，不恢复旧实现 |
| `prototype/workorder-pane.html` | 已由真实右栏插件替换并删除 | 不恢复静态产品入口；历史由 Git 保留 |
| `tools/build-architecture-ascii.mjs` | 保留，它维护 `DESIGN.md` 的生成区 | 只有对应生成区删除后才可一并删除 |
| `tools/render-diagrams.mjs` 与 `diagrams/` | 保留，它们维护当前设计引用的时序图 | 只有设计不再引用这些图时才可删除 |
| `start-dev.ps1` | 启动 `business-agent` Profile；工单服务保持独立启动 | 后续部署编排不得改变服务与 DSH 的独立边界 |
| `_archive/` | 不读取、不修改，不作为实现依据 | 本计划不处理 |

清理遵循“先提取可执行契约，再替换实现，最后删除旧入口”。MVP 完成后不得同时维护静态原型、旧 mock 和新实现三套事实来源。

## 任务总览

| Task | 结果 | 独立验证重点 | 依赖 |
|---|---|---|---|
| 0 | 产品决策与 MVP 契约冻结 | 文档一致性、路径与格式检查 | 无 |
| 1 | 独立可运行的最小工单服务 | HTTP、SSE、MCP、异步返回 | 0 |
| 2 | 可启动的业务 Bundle/Profile | 包级构建、配置 dump、Web 启动 | 1 |
| 3 | DSH 中出现原生工单工具 | 工具 schema、顶层 `tool/call` | 2 |
| 4 | `needsHuman` 能投递到绑定会话 | 空闲、忙碌、去重、不可信文本 | 3 |
| 5 | 右栏展示真实工单状态 | 快照、SSE 刷新、窄屏、只读 | 4 |
| 6 | 完整最小闭环 | 无密钥 E2E、快照、真实页面演示 | 5 |
| 7 | 重启不丢状态和待投递事件 | 服务与 Host 重启恢复 | 6 |
| 8 | 失败、重试和改绑定可审计 | 幂等、冲突、非法依赖拒绝 | 7 |
| 9 | 交付件可安全打开 | 资源标识、权限、失败态 | 8 |
| 10 | 可按部署环境安全配置 | 认证、CORS、配置失败 | 9 |
| 11 | 多工单与完整 UI 状态 | 选择、空态、断线、可访问性 | 10 |
| 12 | mock 可替换为生产适配器 | 契约套件对真实适配器复用 | 11 |

## Task 0：关闭产品决策并冻结 MVP 契约

**目标：** 消除会改变状态机、存储归属或页面导航的歧义，给后续任务一个不可随意漂移的最小协议。

**范围：** 复核 [DESIGN.md 已确认的产品约束](DESIGN.md#已确认的产品约束)；定义 MVP 的订单、活动、事件和工具最小字段；确定错误码、`rev`、幂等键和异步受理语义；确定包名、目录和 Profile 名；清理开始实现前已经存在的文档门禁失败。MVP 使用以下值：

| 决策 | 已确认值 |
|---|---|
| 绑定归属 | 唤醒器持久化；一张工单一个主会话，一个会话可绑定多张工单 |
| 右栏当前工单 | 当前会话最近活动工单；MVP 只显示一张，选择器延后到 Task 11 |
| 启动前状态 | `ready`；只允许 `ready -> running` |
| 人工活动完成 | `start_activity` 只开始，`finish_activity` 显式完成 |
| 交付件标识 | 不透明 `resourceId`；MVP 只展示元数据，Task 9 才开放读取 |
| 唤醒预算 | 按会话和工单计数，默认连续 3 次；只由真人输入重置 |

**不做：** 不写运行时代码，不删除存量实现，不扩充 UI 细节。

**任务执行时必须验证：**

```sh
pnpm run verify-md-links
pnpm run test:docs
git diff --check
```

**完成标准：** 六项决策均有明确答案；MVP 状态迁移与字段不存在“实现时再定”；设计文档、服务 README 和本计划没有互相冲突。若业务方不接受任一默认值，先修订 Task 0 及受影响的后续验收，再进入 Task 1。

当前 `test:docs` 的已知阻断项是 `business-agent/README.md`、`business-agent/workorder-service/README.md` 及 `_archive/` 下两个 README 缺少双语配对。Task 0 必须先决定是补齐配对还是按仓库规则建立明确排除；在命令恢复全绿前不得把 Task 0 标为完成。处理 `_archive/` 只为消除门禁时，不得把其中内容重新当成当前设计依据。

## Task 1：重建最小工单服务

**目标：** 得到一个零 DSH 依赖、可单独构建和运行的最小业务服务，为后续所有集成提供稳定端点。

**范围：** 先把现有 smoke test 中仍属于 MVP 的行为改成黑盒契约测试，再按契约保留或重写 `workorder-service/`。MVP 保留一个包含五个串行活动的种子工单、`ready -> running`、第 3 步人工等待、其余步骤自动执行、`GET /health`、`GET /orders/:id`、按 `rev` 推送的 SSE，以及 `get_order`、`start_order`、`start_activity`、`finish_activity` 四个 MCP 工具。写工具必须立即返回受理结果；自动活动在后台逐步推进。服务包改用仓库包命名规则，并提供独立 `build`、`test` 和 `start` 命令。

**不做：** 不做数据库、鉴权、交付件读取、多工单、失败重试、输入重绑、宿主会话绑定或 UI。允许进程内状态，但 README 必须明确重启会重置。

**任务执行时必须验证：**

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-service build
pnpm --filter @deepseek-ai/dsh-business-workorder-service test
pnpm --filter @deepseek-ai/dsh-business-workorder-service start
```

第三条命令由黑盒脚本在随机可用端口启动和关闭服务，验证健康检查、HTTP 快照、SSE 递增版本、四个 MCP 工具、非法迁移拒绝和写工具不等待后台活动完成。测试必须拥有监听器和计时器的关闭过程，不能留下端口或进程。

**完成标准：** 服务离开 DSH 仍可构建、启动和完成整条最小产线；契约测试全部通过；旧服务入口和重复实现已经删除。

## Task 2：建立插件与 Profile 骨架

**目标：** 建立后续 Host 与 Client 能力共用的业务 Bundle，并证明它能通过受支持的 `dsh` Profile 启动。

**范围：** 创建 `bundle/`、`plugins/workorder-host/`、`plugins/workorder-ui/` 的最小包结构、TypeScript 配置、README 和 Bundle patch；Host 与 Client 插件此时只注册可观察的启动标记，不接业务行为。初始化名为 `business-agent` 的自定义 Web Profile，更新 `start-dev.ps1` 使用该 Profile，并确保 Bundle 声明所有裸插件依赖。

**不做：** 不挂 MCP、不订 SSE、不渲染工单 UI、不修改底座包。

**任务执行时必须验证：**

```sh
pnpm --filter @deepseek-ai/dsh-business-agent... build
pnpm dsh --profile business-agent --dump-config
powershell -File business-agent\start-dev.ps1 -NoOpen
pnpm run verify-cordis-config
pnpm run verify-client-packages
```

启动验收使用隔离的 `DSH_HOME`，确认配置中只有一套业务 Bundle 行、Web 在指定端口可访问、Host 和 Client 插件均加载；关闭后不得残留进程。

**完成标准：** 三个业务包能独立构建，组合 Profile 能从干净目录初始化并启动，卸载 Bundle 后不残留注册效果。

## Task 3：以原生工具接入 MCP

**目标：** 让 DSH 通过官方 MCP Client 加载工单服务，并使会话级顶层事件可观察到真实 `orderId`。

**范围：** Bundle patch 挂载 `@deepseek-ai/dsh-mcp-client` 的 `streamable-http` 连接；固定 `serverName` 和服务 URL 配置；验证工具名、输入 schema、立即返回行为，以及成功 `tool/result` 对应的顶层 `tool/call` 参数。MVP 强制使用 native tools；PTC-only 模式不在本阶段支持。

**不做：** 不建立会话绑定、不消费 SSE、不注入 server instructions、不把动态工单状态加入系统提示词。

**任务执行时必须验证：**

```sh
pnpm --filter @deepseek-ai/dsh-business-agent... build
pnpm --filter @deepseek-ai/dsh-business-workorder-host test
pnpm run test:snapshot -t "business workorder native tools"
pnpm dsh --profile business-agent --dump-config
```

**完成标准：** 四个工具以原生工具出现在模型请求中；真实调用生成包含 `orderId` 的顶层 `tool/call` 和成功结果；MCP server 没有 instructions；服务不可达时插件明确报错或进入已定义的不可用状态，不静默跳过。

## Task 4：接入最小唤醒器

**目标：** 把工单阻塞事件准确投递到已绑定会话，同时不把普通进度写入模型上下文。

**范围：** Host 插件在工单工具成功后记录“会话到工单”的进程内绑定；消费 SSE；按 `orderId + rev` 和阻塞轮次去重；目标 Agent 空闲时调用 `followup()`，忙碌时调用 `inject()`；找不到 live Agent 时保留待投递状态而不是假报成功；把业务文本包在明确的不可信数据标记中。Task 0 确认的唤醒预算可以先在内存中执行。

**不做：** 不做重启恢复、数据库、跨实例协调或完整重连重放；这些属于 Task 7。普通 `running`、`done` 事件不进入会话。

**任务执行时必须验证：**

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-host build
pnpm --filter @deepseek-ai/dsh-business-workorder-host test
pnpm run test:snapshot -t "business workorder wake"
```

测试必须覆盖：成功工具调用建立绑定，失败结果不建立绑定；空闲 Agent 被 `followup()` 唤醒；忙碌 Agent 只收到 `inject()`；重复 SSE 不重复投递；非阻塞进度不投递；恶意标题只能作为不可信文本出现；插件卸载会终止 SSE 和重连计时器。

**完成标准：** 不启动 UI 也能用测试宿主验证完整绑定和唤醒行为，且无重复投递、悬挂连接或普通进度泄漏。

## Task 5：接入实时只读右栏

**目标：** 用真实 Client 插件替换静态原型，让用户在当前会话右栏看到工单的权威状态。

**范围：** 注册独立的右栏 tab 类型和 body；Client 通过 Host Remote 只取得当前会话绑定的 `orderId`，再从浏览器直连业务服务读取快照和 SSE，不让 Host 复制或代理业务状态；为开发来源增加最小 CORS 配置，生产来源限制留到 Task 10。首屏拉快照，SSE 只作为刷新信号，发现 `rev` 缺口时重拉快照；展示活动顺序、当前状态和输出元数据。所有用户可见文本进入 typed locale 字典。右栏没有写按钮。

**不做：** 不做多工单选择、交付件预览、完整异常恢复和生产级视觉丰富；只保留完成 MVP 所需的加载、正常、等待和基础错误状态。

**任务执行时必须验证：**

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-ui build
pnpm --filter @deepseek-ai/dsh-business-workorder-ui test
pnpm run verify-client-ui-i18n
pnpm run test:gui -- business-agent
```

手工验收必须在真实业务 Profile 上覆盖桌面与窄窗口：状态变化不刷新整页即可出现；长标题不溢出或遮挡；断开 SSE 后出现明确状态；页面没有写控件。按 `record-browser-gif` 流程录制真实服务与真实页面 GIF。验收通过后删除 `prototype/workorder-pane.html`。

**完成标准：** 静态原型已经被真实插件取代，右栏只依赖服务快照和事件，且视觉证据、组件测试、国际化检查全部通过。

## Task 6：锁定 MVP 端到端闭环

**目标：** 从真实 DSH 页面完成一次最小工单，不依赖手工修改状态或测试专用入口。

**范围：** 建立确定性无密钥场景：用户要求启动种子工单；模型调用原生 `start_order`；服务异步完成前两个自动活动；右栏刷新为第 3 步人工等待；唤醒器通知同一会话；用户要求开始后模型调用 `start_activity`；用户报告线下工作完成后模型调用 `finish_activity`；服务继续完成后两个自动活动，右栏最终显示工单完成。补齐会话记录快照、浏览器 E2E 和一条人工演示路径。

**不做：** 不把 Task 7 之后的生产能力塞进 MVP 验收。进程重启后丢状态在本任务仍是已知限制。

**任务执行时必须验证：**

```sh
pnpm --filter @deepseek-ai/dsh-business-agent... build
pnpm --filter @deepseek-ai/dsh-business-agent... test
pnpm run test:snapshot -t "business workorder vertical slice"
pnpm run test:web:built -t "business workorder vertical slice"
git diff --check
```

**完成标准：** 上述流程从页面到服务再回到页面完整通过；快照证明模型只看到用户消息、必要的唤醒提示、按需查询结果和工具结果，不包含普通进度历史。Task 6 通过即为 MVP；通过前不得开始生产强化。

## Task 7：持久化与重启恢复

**目标：** 服务或 DSH Host 重启后不丢工单状态、会话绑定、消费游标、唤醒预算或待投递阻塞事件。

**范围：** 为业务状态与决策记录增加单一持久化实现；为 Host 侧绑定、游标、预算和待投递通知增加持久化；SSE 支持游标恢复或明确的快照重同步；重启时先恢复再消费新事件。

**任务执行时必须验证：**

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-service build
pnpm --filter @deepseek-ai/dsh-business-workorder-service test
pnpm --filter @deepseek-ai/dsh-business-workorder-host build
pnpm --filter @deepseek-ai/dsh-business-workorder-host test
pnpm run test:snapshot -t "business workorder restart recovery"
pnpm run test:web:built -t "business workorder vertical slice"
```

测试分别杀停并重启服务与 Host，验证不回退状态、不漏唤醒、不重复唤醒、不重复提交活动。

**完成标准：** 任一单进程重启都能恢复同一条产线；持久化类型变更已按仓库要求声明；Task 6 继续通过。

## Task 8：异常处置与幂等写

**目标：** 支持失败、重试、跳过和输入重绑，并让每个成功决策可审计、每个重复请求可安全重试。

**范围：** 增加失败状态、`retry_activity`、`bind_input` 及经 Task 0 确认的其他处置工具；使用不透明资源标识校验前序输出；写操作接受幂等键和预期 `rev`；记录不可改写的决策事实。

**任务执行时必须验证：**

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-service build
pnpm --filter @deepseek-ai/dsh-business-workorder-service test
pnpm --filter @deepseek-ai/dsh-business-workorder-host test
pnpm run test:snapshot -t "business workorder recovery"
pnpm run test:web:built -t "business workorder vertical slice"
```

测试覆盖重复幂等键、不同幂等键并发、过期 `rev`、不存在资源、后向依赖、循环依赖、失败后重试和审计字段。

**完成标准：** 所有非法迁移和资源引用明确失败，成功决策与状态事件可通过操作标识关联，重复请求不会推进两次。

## Task 9：交付件读取

**目标：** 用户能从右栏安全打开活动输出，而不暴露服务端或宿主文件路径。

**范围：** 服务返回 `resourceId` 与展示元数据；提供受认证的预览或下载读取；右栏接入 DSH 资源/预览能力或隔离下载入口；处理资源不存在、无权限、类型不支持和过期。

**任务执行时必须验证：**

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-service build
pnpm --filter @deepseek-ai/dsh-business-workorder-service test
pnpm --filter @deepseek-ai/dsh-business-workorder-ui build
pnpm --filter @deepseek-ai/dsh-business-workorder-ui test
pnpm run verify-client-ui-i18n
pnpm run test:web:built -t "business workorder deliverable"
```

手工验收覆盖桌面与窄屏，并按 `record-browser-gif` 流程记录真实预览。自动验证覆盖无权限、过期资源和 Task 6 回归。

**完成标准：** 用户只能通过不透明标识读取授权资源，页面不泄漏本地路径或内部存储位置。

## Task 10：认证、CORS 与部署配置

**目标：** 把仅限本机演示的连接方式收紧为可部署配置。

**范围：** 分别定义看板读、SSE 消费和 MCP 写的凭据；限制 CORS 来源；把服务 URL、超时、重连和唤醒预算变为经过校验的 Cordis 配置；缺失或矛盾配置在最早可判断时失败。

**任务执行时必须验证：**

```sh
pnpm --filter @deepseek-ai/dsh-business-agent... build
pnpm --filter @deepseek-ai/dsh-business-agent... test
pnpm run verify-cordis-config
pnpm run test:snapshot -t "business workorder authorization"
pnpm run test:web:built -t "business workorder vertical slice"
```

测试覆盖有效凭据、缺失凭据、错误来源、凭据过期、配置错误和日志脱敏。

**完成标准：** 默认配置不把写接口暴露给任意浏览器来源，密钥不进入日志、会话事件、快照或仓库。

## Task 11：多工单与完整产品状态

**目标：** 在不改变“右边看、左边说”的前提下支持一个会话处理多张工单，并补齐日常使用状态。

**范围：** 增加当前会话已绑定工单的只读选择器；默认定位最近活动工单；补齐空态、加载、断线、无权限、不存在、完成、预算耗尽和恢复提示；完成键盘操作、可访问名称和中英文文案。

**任务执行时必须验证：**

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-ui build
pnpm --filter @deepseek-ai/dsh-business-workorder-ui test
pnpm run verify-client-ui-i18n
pnpm run test:web:built -t "business workorder multi-order"
pnpm run test:web:built -t "business workorder vertical slice"
```

手工验收覆盖桌面与移动宽度、键盘操作和可访问名称，并按 `record-browser-gif` 流程记录多工单导航。

**完成标准：** 工单切换不会改变业务状态或建立第二个写入口，动态内容不会引起布局跳动或遮挡。

## Task 12：生产业务系统适配

**目标：** 证明 mock 可以被真实业务系统替换，而 DSH Host 与右栏不需要改业务逻辑。

**范围：** 把 Task 1、7、8、9 的黑盒契约测试抽成适配器一致性套件；真实系统实现 HTTP、SSE、MCP、资源读取和恢复语义；部署配置切换目标服务。

**任务执行时必须验证：**

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-service build
pnpm --filter @deepseek-ai/dsh-business-workorder-service test:contract -- --adapter mock
pnpm --filter @deepseek-ai/dsh-business-workorder-service test:contract -- --adapter production
pnpm run test:snapshot -t "business workorder production adapter"
pnpm run test:web:built -t "business workorder vertical slice"
```

同一套契约分别对 mock 与真实适配器运行，再对真实适配器验证 Task 6 闭环、重启恢复和鉴权场景。真实系统无法在 CI 启动时，测试所有者必须提供受控环境和可复查结果，不能用 mock 结果代替。

**完成标准：** 切换服务只改配置；Host 插件与 Client 插件无需条件分支；真实适配器通过全部必需契约。

## Dev Note

Task 0 至 Task 6 已完成独立构建与聚焦验证，MVP 垂直闭环由无密钥 Session 快照和 built-Web 场景固定。真实模型调用仍需要 `DEEPSEEK_API_KEY`，不由无密钥回放结果替代。MVP 经产品验收后，从 Task 7 开始继续生产强化。
