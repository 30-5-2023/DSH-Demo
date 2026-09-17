# 业务 Agent 二次开发工作区

以 DeepSeek Harness（DSH）为底座，二次开发成业务系统调度 Agent。本目录是这件事的唯一入口。

## 先看哪一份

| 想知道 | 看 |
|---|---|
| **这件事的架构、边界、页面、关键时序** | **[DESIGN.md](DESIGN.md)** ← 唯一的设计文档 |
| **按什么顺序开发、每一步怎样验收** | **[DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)** ← 严格串行的任务计划 |
| 工单服务怎么跑、接口确切形状 | [workorder-service/README.md](workorder-service/README.md) |
| 页面长什么样 | [prototype/workorder-pane.html](prototype/workorder-pane.html)（单文件，双击就开） |
| 当时为什么这么定、否掉了什么 | `_archive/`（**设计时不要读**） |

细节与架构混在一起会带偏判断：**先把架构对齐，末端细节后补。** 讨论结论一律并进 `DESIGN.md`，不要再铺开新的细节文档。

## 目标与边界

- **底座零改动**：不修改 `packages/`、`apps/` 既有行为；新能力一律走插件（Cordis 插件 / Bundle / Profile patch），便于与上游同步。
- **产物集中在本目录**：新增插件包、Profile 配置、原型与设计文档都可追溯，不与上游文件混在一起。
- **不对接底座内部**：对业务的调度能力以插件提供的工具为入口，不改 agent loop。

## 开发基线

| 项 | 值 |
|---|---|
| 开发分支 | `dev/secondary` |
| 底座仓库 | https://github.com/deepseek-ai/deepseek-harness.git |

固定提交会很快失效。每个开发任务开始时在任务记录中写明实际基线，结束时附上实际运行的验收命令；不要把临时提交号写回长期文档。

## 跑起来

首次使用或上游同步后先构建一次：

```sh
pnpm run build
```

推荐用脚本启动（自动切到仓库根、固定端口 **3081**、缺产物直接报错）：

```powershell
powershell -File business-agent\start-dev.ps1              # 端口 3081，缺省会打开浏览器
powershell -File business-agent\start-dev.ps1 -NoOpen      # 只起服务
powershell -File business-agent\start-dev.ps1 -ReplaceExisting   # 先停掉占用 3081 的旧实例
powershell -File business-agent\start-dev.ps1 -Source      # 改用 pnpm dsh 源码形态启动
```

本机只有 Windows PowerShell 5.1（没有 `pwsh`），所以用 `powershell`。脚本刻意只用 ASCII：5.1 会把无 BOM 的脚本按 ANSI 解码，中文注释会乱码。脚本默认调用已构建的 CLI，不经 tsx/esbuild；`-Source` 切回源码形态。

启动成功：终端出现 `dsh web:` 开头的 URL 行，且 `http://127.0.0.1:3081` 可访问（未带进程 token 时返回 `401` 属正常，用打印出的 URL 打开）。

重启前先 `-ReplaceExisting`，否则会以 `EADDRINUSE` 直接失败。端口走 `--port 3081` 而不是改配置：上游是 `port: !!js ctx.webStartup.port ?? 3080`，命令行 flag 优先，这样既不动底座文件，也不用整段抄一份 `webserver` 配置。

## 工单服务单独验（不启动 DSH）

```sh
cd business-agent/workorder-service
node test/smoke.mjs        # 15 项自检
node bin/serve.js          # 独立启动，127.0.0.1:8090
```

## 目录

```
DESIGN.md              唯一的设计文档（架构 · 边界 · 原型 · 关键时序）
DEVELOPMENT_PLAN.md    严格串行的开发任务与验收标准
prototype/             右侧页面原型（单文件 HTML）
diagrams/              时序图 PNG（mermaid 在这里不渲染，所以要存图）
tools/                 两张 ASCII 图与 PNG 的生成脚本
workorder-service/     工单服务（= 业务系统，今日是 mock）
start-dev.ps1          端口 3081 的启动脚本
_archive/              讨论存档，设计时不要读
```
