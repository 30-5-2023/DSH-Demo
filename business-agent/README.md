# 业务 Agent 二次开发工作区

本目录是「以 DeepSeek Harness（DSH）为底座，二次开发成业务系统调度 Agent」这一目标的唯一入口：记录快捷启动方式、验证方式、新增特性登记表与需求澄清文档。

## 目标与边界

- **底座零改动**：不修改 `packages/`、`apps/` 既有行为；一切新能力优先以插件（Cordis 插件 / Bundle / Profile patch）实现，便于后续与上游同步。
- **二次开发产物集中在本目录**：新增插件包、Profile 配置、需求与特性文档均可追溯，不与上游文件混在一起。
- **业务系统对接走工具与插件**：对业务系统的调度能力以插件提供的工具（tool）为入口，不直接改 agent loop。

## 基线与分支

| 项 | 值 |
|---|---|
| 基线提交 | `0d1f500`（`master` = `origin/master`，工作树干净） |
| 开发分支 | `dev/secondary` |
| 底座仓库 | https://github.com/deepseek-ai/deepseek-harness.git |

## 快捷启动（本机 Web 界面）

默认端口固定为 **3081**。首次使用或上游同步后必须先构建：

```sh
pnpm run build
```

推荐用脚本启动（自动切到仓库根目录、固定端口、缺产物时直接报错）：

```powershell
powershell -File business-agent\start-dev.ps1              # 端口 3081，缺省会打开浏览器
powershell -File business-agent\start-dev.ps1 -NoOpen      # 只起服务，不打开浏览器
powershell -File business-agent\start-dev.ps1 -Port 3099   # 临时换端口排查冲突
powershell -File business-agent\start-dev.ps1 -Source      # 改用 pnpm dsh 源码形态启动
```

本机只装了 Windows PowerShell 5.1，没有 `pwsh`（PowerShell 7），所以命令用 `powershell`。脚本内容刻意只用 ASCII：5.1 会把无 BOM 的脚本按 ANSI 解码，中文注释会变乱码甚至解析失败。执行策略是 `CurrentUser = RemoteSigned`，本地新建的脚本可直接运行。

脚本默认调用已构建的 CLI（`node apps/cli/lib/bin.js`），它不经过 tsx/esbuild，在 Agent 的文件沙箱内也能启动；`-Source` 切回上游文档口径的源码启动 `pnpm dsh --profile web --port 3081`。两者都要先有 `pnpm run build` 的产物。

启动成功的判据：终端出现 `dsh web:` 开头的 URL 行，且 `http://127.0.0.1:3081` 可访问（未带进程 token 时返回 `401` 属正常，用打印出的 URL 打开即可）。

## 验证方式

| 场景 | 命令 |
|---|---|
| 人在终端启动并看图 | `powershell -File business-agent\start-dev.ps1 -ReplaceExisting` |
| 端口是否真的被本项目占用 | `netstat -ano \| Select-String ':3081'` |
| 服务是否起来 | `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:3081/`（期望 `401`） |
| Agent 在文件沙箱内代跑验证 | `powershell -File business-agent\start-dev.ps1 -ReplaceExisting -NoOpen -DshHome tmp\dsh-dev-home` |

Agent 代跑那一行有两个原因：沙箱只允许写工作区内文件，而默认 `$DSH_HOME`（`~/.dsh`）在工作区外会被拒绝写；同时沙箱内命名管道受限，`pnpm dsh` 走的 tsx/esbuild 会以 `spawn EPERM` 失败，改用已构建的 `apps/cli/lib/bin.js` 可绕开。`tmp/` 已在 `.gitignore` 中。

## 端口占用与重启约定（2026-09-16 记录）

- `127.0.0.1:3080`：承载当前对话的 DSH 部署（`~/.dsh/profiles/local`，含 `/inspector` 插件），不要动。
- `127.0.0.1:3081`：本项目开发实例的端口。记录时它被一个旧实例占用（服务的是本仓库 `apps/web/dist` 产物），目前空闲。

重启约定：由 Agent 在重启前停掉占用 3081 的旧实例，否则 web 启动会以 `listen EADDRINUSE: address already in use 127.0.0.1:3081` 直接失败。脚本已内建该动作：

```powershell
powershell -File business-agent\start-dev.ps1 -ReplaceExisting
```

`-ReplaceExisting` 只结束确实在监听目标端口的那个进程，并打印出 PID 与进程名。需要手工排查时：

```powershell
netstat -ano | Select-String ':3081'          # 末列是 PID
Stop-Process -Id <PID>
```

## 端口为什么用 `--port` 而不是改配置

上游的端口取值是 `port: !!js ctx.webStartup.port ?? 3080`：命令行 flag 优先于配置字面量。用 `--port 3081` 有两个好处——不改任何底座文件；不需要复制整段 `webserver` 配置（patch 是整段替换 `config`，抄一份会在上游新增字段时悄悄丢字段）。

## 文档索引

| 文档 | 用途 |
|---|---|
| [FEATURES.md](FEATURES.md) | 新增特性登记表：编号、状态、实现方式、涉及插件、验证命令 |
| [requirements/README.md](requirements/README.md) | 需求澄清文档的存放规则、命名规范与索引 |
| [requirements/TEMPLATE.md](requirements/TEMPLATE.md) | 需求澄清文档模板 |

## 后续开发约定

1. 新功能一律做成插件包（建议放在 `business-agent/plugins/<name>/`，或在 `packages/experimental/` 下先验证），通过 `dsh plugin --profile <name> add <path>` 挂到 Profile 上。
2. 每次新增功能同时在 [FEATURES.md](FEATURES.md) 登记一行，并补上验证命令。
3. 需求不明确时先写澄清文档（[requirements/TEMPLATE.md](requirements/TEMPLATE.md)），确认后再动手。
4. 底座保持可同步：需要改 `packages/` 时先确认没有插件扩展点可用，并把改动记录到对应特性的备注里。
