> **已归档：这是讨论存档，不要作为设计依据。当前设计只有一份 → [../DESIGN.md](../DESIGN.md)**

# 新增特性登记表

本文件记录在 DSH 底座之上以插件方式新增的全部特性。每完成一个特性，追加一行登记表并补一节详情；未登记的改动视为未完成。

## 登记表

| 编号 | 特性 | 状态 | 实现方式 | 涉及插件/文件 | 需求来源 | 验证 |
|---|---|---|---|---|---|---|
| F-000 | 本项目启动端口固定为 3081 | 已完成 | 启动参数（`--port`），不改底座 | `business-agent/start-dev.ps1` | 本文档「背景」 | `powershell -File business-agent\start-dev.ps1 -ReplaceExisting` 后 `netstat -ano \| Select-String ':3081'` |
| F-001 | 二次开发工作区与文档索引 | 已完成 | 文档 | `business-agent/`、`AGENTS.md` | 本文档「背景」 | 打开 `AGENTS.md` 能索引到本目录 |
| F-002 | 右侧浏览页替换为工单作业页（只读），产线由左侧对话驱动 | 规划中 | 双面插件包 + Profile 覆盖层，不改底座 | `business-agent/plugins/dsh-plugin-workorder/`、`business-agent/workorder.patch.yml`、`business-agent/prototype/workorder-pane.html` | [0001](requirements/0001-workorder-execution-pane.md) | 展开右栏默认页为「工单作业」，页面上无写入口；在对话里说「完成第 3 步」后右侧三处同步变化。详见需求文档「验收标准」 |
| F-003 | 工单服务（= 业务系统，今日是 mock） | 已完成 | 独立包，零 DSH 依赖；HTTP 读接口 / SSE 事件流 / MCP 工具面三张对外面 | `business-agent/workorder-service/` | [0003](requirements/0003-left-right-system-split.md) | `cd business-agent/workorder-service && node test/smoke.mjs` → 15/15，全程不启动 DSH |

状态取值：`规划中` / `开发中` / `待验证` / `已完成` / `已废弃`。

## 特性详情模板

复制以下模板追加到本文件末尾，编号取登记表中下一个可用值。

```md
## F-00X 特性名称

- **状态**：规划中 / 开发中 / 待验证 / 已完成 / 已废弃
- **需求来源**：链接到 `requirements/` 下的澄清文档，或说明口头需求的确认时间
- **目标**：这个特性让 Agent 能做什么，对应业务系统的哪个环节
- **实现方式**：插件包名与路径、挂载到哪个 Profile、暴露哪些工具
- **对外接口**：工具名与参数、访问的业务系统地址与凭据来源
- **边界**：明确不做什么，避免范围蔓延
- **验证命令**：一条可复制的命令，以及期望看到的现象
- **已知限制**：暂时不支持的场景
- **变更记录**：日期 + 变更摘要
```

## 已登记特性详情

### F-000 本项目启动端口固定为 3081

- **状态**：已完成
- **目标**：把本项目的开发实例与本机既有部署（3080）隔离开，便于后续边开发边验证。
- **实现方式**：不改底座配置文件；启动时传 `--port 3081`，由 `business-agent/start-dev.ps1` 固定。上游的 `port: !!js ctx.webStartup.port ?? 3080` 决定了 flag 优先，因此无需复制或覆盖 `webserver` 行的 `config`。
- **验证命令**：`powershell -File business-agent\start-dev.ps1 -ReplaceExisting -NoOpen`，另开终端执行 `netstat -ano | Select-String ':3081'`，应看到 `LISTENING`。
- **已知限制**：3081 曾被一个旧实例占用（2026-09-16 记录，现已空闲）；重启约定是由 Agent 用 `-ReplaceExisting` 先停掉占用目标端口的进程。`--patch` 方式覆盖 `webserver` 行会整段替换 `config`，上游新增字段会被丢掉，因此不采用。
- **变更记录**：2026-09-16 建立登记表并登记本条。

### F-001 二次开发工作区与文档索引

- **状态**：已完成
- **目标**：让「新增了什么能力、需求是怎么澄清的」有固定去处，人和 Agent 都能从 `AGENTS.md` 一次跳转到位。
- **实现方式**：新增 `business-agent/` 目录（README、特性登记表、需求澄清模板与索引、启动脚本），并在根 `AGENTS.md` 增加索引段落。
- **验证命令**：在根 `AGENTS.md` 中搜索 `business-agent`，应命中索引段落。
- **已知限制**：本目录不进入上游文档门禁范围（`docs/**` 才有双语与元数据要求），因此按中文单行成段的写法维护即可。
- **变更记录**：2026-09-16 建立。

### F-002 右侧浏览页替换为工单作业页

- **状态**：规划中
- **需求来源**：[requirements/0001-workorder-execution-pane.md](requirements/0001-workorder-execution-pane.md)（2026-09-16，澄清中）
- **目标**：让 Web 界面右栏展开后的默认页变成工单作业台——上半部按顺序展示产线活动（工具 / agent / 手工 / 质检 × 自动 / 需人工）及其输入输出件，下半部汇总交付件。**页面只读**：自动化活动由产线自己跑，需人工的活动与失败后的处置由人在左侧对话里对 agent 下达，页面同步反映结果。左侧对话页结构保持不变。
- **实现方式**：新增双面插件包 `business-agent/plugins/dsh-plugin-workorder/`——宿主半提供 `workorder` 领域服务、可替换的业务系统适配器、只读的 `/workorder/api/*` 与 10 个模型工具；浏览器半用 `ctx.sidebarRightTabs.register` + `ctx.slots.register` 注册右栏只读页面类型。通过 `business-agent/workorder.patch.yml` 覆盖层以 `--patch` 挂到 Profile，不改 `packages/` 与 `apps/`。
- **对外接口**：模型侧 `workorder_list` / `get` / `start_activity` / `finish_activity` / `decide` / `bind_input` / `retry_activity` / `resume_activity` / `fail_activity` / `skip_activity`（注册进宿主 `tools` 注册表的全局层）；浏览器侧只有 `GET /workorder/api/*`。业务系统地址走行配置 `baseUrl`，第一版不认证。
- **边界**：右侧页面不提供任何写入口；不改左侧对话页与 agent loop，不注册提示词段落、不新增会话事件；不做产线编排（结构、自动化标记、输入绑定都由业务系统给出）；第一版不做认证、不做工单增删。
- **验证命令**：`powershell -File business-agent\start-dev.ps1 -ReplaceExisting`，打开打印出的 URL 并展开右栏，默认页应为「工单作业」；在左侧对话里说「把第 5 步的输入换成第 3 步的复核结论」，卡片上的 `←n` 前缀应随之改变。完整判据见需求文档「验收标准」。
- **已知限制**：需要先完成 M0–M6 里程碑；**M0（产线自动执行由谁负责）已定**——服务自己的执行引擎推产线，适配器只做订阅与唤醒（F-003 已落地）；右栏状态是内存态，刷新后回到默认页；业务系统字段未确认前只能用 mock 适配器验收；`--patch` 覆盖层改动必须重启进程（`patchReload: live` 只覆盖 profile 自己的 `cordis.patch.yml`）；该路径没有仓库级端到端测试，M1 必须真起服务看 `globalThis.__DSH_BOOT__.entries`；`tools.mode` 为 `ptc`/`both` 时工具不在模型清单里，改为经 `run_code` 可达。
- **变更记录**：2026-09-16 登记并完成需求设计（澄清中）；同日按源码核对修正三处早期误判（覆盖层热重载、宿主半 inject 并集、浏览器半禁用 `exports.default`）；同日按需求方决定把右侧改为纯只读看板，工单工具集从「另立需求」提前为第一版必经路径，浏览器侧写接口全部撤销；同日按需求方澄清把活动模型扩展为「类型 × 自动化标记」两维、状态加 `waiting`、输入改为可改的上游输出绑定，工具集重心从逐步推进改为异常处置；同日按需求方澄清把服务与 agent 适配器拆分（F-003），自建工具集作废、改用业务系统的 MCP 工具。

### F-003 工单服务（= 业务系统，今日是 mock；执行引擎 + 可换的执行实现）

- **状态**：已完成（demo 版）
- **需求来源**：[requirements/0003-left-right-system-split.md](requirements/0003-left-right-system-split.md)、[ARCHITECTURE.md](ARCHITECTURE.md)
- **目标**：左侧与右侧是两个系统。右侧工单系统要有自己的独立服务：与前端靠接口交互，与左侧 agent 靠约定的 MCP 交互；服务本身零 DSH 依赖，能单独跑、单独验。**这个服务就是业务系统**（今日是 mock 实现，真实部署由业务方提供同一套东西），执行引擎属于它，不换；接口在这边对齐，真实实现照做。
- **实现方式**：新增独立包 `business-agent/workorder-service/`（纯 ESM、无构建步骤），加进 `pnpm-workspace.yaml` 的 `business-agent/*` glob。服务对外三张脸：① HTTP（读数据 + 绑定登记）② SSE 事件流（右栏与 agent 适配器订同一条）③ MCP streamable-http（agent 查询与推进）。执行引擎见 `src/engine.js`；可以单换的是执行实现 `src/executor.js`（demo 缺省接内置模拟实现，真实实现给 `createService({ executor })` 传一个真去跑活动的对象）。
- **对外接口**：见服务 README。工具名在宿主侧变成 `mcp__workorder__*`。两条必须守住的约定：所有工具立即返回；工单号字段叫 `orderId`。另有一条：MCP server 不返回 `instructions`（会被注入系统提示词）。
- **边界**：不持久化（状态在内存，重启回初始示例）；不做鉴权（监听 127.0.0.1）；不主动知道 agent 的存在（只发事件，谁来消费是消费者的事）。
- **验证命令**：`cd business-agent/workorder-service && node test/smoke.mjs`，期望 15/15 通过且**全程不启动 DSH**（末两项验证换执行实现后引擎行为不变）；`node bin/serve.js` 后 `node test/standalone-check.mjs` 可看到产线自己跑并在人工活动处停住。
- **已知限制**：demo 的 MCP 工具名与参数就是交给业务方照做的契约，不是照着谁拟的；内置模拟实现的时长与失败注入只是演示旋钮，`/demo/*` 在真实实现下回 409；不持久化，重启丢状态；服务与 DSH 今天的接线（适配器、右栏取数）尚未开始。
- **变更记录**：2026-09-16 建立并完成 demo 版实现；同日按需求方澄清把「模拟产线引擎」收回服务内部；同日按需求方再次澄清**不再单列「业务系统」这一层**——业务系统就是工单服务，今日是 mock，接口在这边对齐、真实系统照做；`state.upstream` 随之改名 `state.executor`（「上游」在领域模型里专指前序步骤），自检 15 项保持全绿。
