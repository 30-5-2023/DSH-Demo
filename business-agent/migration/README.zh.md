# 业务 Agent 迁移与调测

[English](README.md) | 中文

## 摘要

本指南用于把当前业务 Agent MVP 迁移到另一台没有现成代码的 Windows 电脑并完成验证。当前可靠的 MVP 交付物是本 DSH 分支的完整源码归档，因为业务 Bundle 仍通过 `workspace:^` 解析包，并依赖已经构建的 DSH CLI 与 Web 应用。只有目标机具备完全相同的 DSH 基线版本时，才可以只发送变更目录。不得复制密钥、生成的 Profile、依赖目录和本地运行状态。

## 目录

- [改动目录](#changed-directories)
- [选择交付包](#choose-a-delivery-package)
- [准备目标电脑](#prepare-the-target-computer)
- [构建与验证](#build-and-verify)
- [启动各模块](#start-the-modules)
- [端到端调测](#end-to-end-debugging)
- [常见问题](#troubleshooting)
- [Dev Note](#dev-note)

-----

<a id="changed-directories"></a>
## 改动目录

业务专用实现没有修改 `packages/` 或 `apps/`。下面的目录级清单足以用于变更审查和迁移规划；精确文件清单以 Git 为准。

| 路径 | 内容 | 运行时是否必需 |
|---|---|---|
| `business-agent/bundle/` | 业务 Bundle 和 Cordis Profile patch | 是 |
| `business-agent/plugins/workorder-host/` | 会话绑定、事件消费、唤醒路由和唤醒追踪数据流 | 是 |
| `business-agent/plugins/workorder-ui/` | 右侧栏只读工单页面 | 是 |
| `business-agent/plugins/workorder-debug/` | 浮动 mock 重置控件和唤醒链路观察 | 仅开发环境 |
| `business-agent/workorder-service/` | 独立的 mock 工单 HTTP、SSE 和 MCP 服务 | mock 部署需要 |
| `business-agent/start-dev.ps1` 和 `business-agent/setup-profile.ps1` | Profile 初始化和 Web 启动 | 当前 Windows 启动方式需要 |
| `business-agent/tests/` | 跨包和纵向闭环验证 | 否 |
| `business-agent/*.md`、`business-agent/diagrams/` 和 `business-agent/tools/` | 设计、开发、迁移和图表源文件 | 否 |
| `snapshots/session/business-workorder-vertical-slice/` | 无密钥 Session 录制验证 | 否 |
| `.agents/notes/implemented/feature/2026-09-17-business-workorder-agent*` | 已实现的架构决策记录 | 否 |
| `pnpm-workspace.yaml` 和 `pnpm-lock.yaml` | 工作区注册和精确依赖解析 | 从源码构建时需要 |

-----

<a id="choose-a-delivery-package"></a>
## 选择交付包

目标电脑没有 DSH 源码时，应使用完整仓库归档。只有接收方能够确认基础仓库版本完全一致时，才能使用较小的变更包；把这些目录混入其他 DSH 版本不属于受支持的部署方式。

### 完整仓库归档（推荐）

创建归档前必须提交所有需要交付的文件，因为 `git archive` 不包含未提交文件和未跟踪文件。在源电脑的仓库根目录运行：

```powershell
git status --short
git diff --check
$businessRevision = git rev-parse --short HEAD
git archive --format=zip --output "..\deepseek-harness-business-agent-$businessRevision.zip" HEAD
```

发送生成的 ZIP，以及 `git rev-parse HEAD` 输出的完整提交号。不要包含 `.env`、`tmp/`、`node_modules/`、生成的 DSH home、日志或 API key。归档包含源码但不包含 Git 历史；目标机不需要预先存在代码仓库。

### 相同基线上的变更包

目标机已有完全相同的基础版本时，发送 `business-agent/`、`pnpm-workspace.yaml` 和 `pnpm-lock.yaml`。只有目标机需要运行 Session 录制检查时才加入 `snapshots/session/business-workorder-vertical-slice/`。Agent Note 只在开发审查时需要。应复制清单中的完整目录，不要挑选单个编译文件，然后在目标机重新安装和构建。

### 仅构建产物交付

当前 MVP 尚未生成受支持的独立可执行文件或便携插件 ZIP。直接复制 `lib/` 和 `node_modules/` 不可靠，因为 Profile 安装器需要解析工作区包，pnpm 链接也可能包含与机器相关的路径。仅构建产物部署需要单独增加发布任务，把 Bundle、三个插件、mock 服务、DSH 运行时和平台相关原生依赖一起打包。

-----

<a id="prepare-the-target-computer"></a>
## 准备目标电脑

目标电脑需要 Windows PowerShell、可访问已配置的 npm registry、Node.js `^22.19.0` 或 `>=24.0.0`，以及 pnpm `11.7.0`。若复用原生依赖，源电脑和目标电脑必须使用相同的操作系统与 CPU 架构；更推荐在目标机执行干净构建。

1. 将完整归档解压到较短路径，例如 `C:\work\deepseek-harness`。
2. 安装或启用 pnpm `11.7.0`。如果环境提供 Corepack，运行 `corepack enable` 和 `corepack prepare pnpm@11.7.0 --activate`。
3. 在仓库根目录本地创建 `.env` 并写入 `DEEPSEEK_API_KEY`。只有部署使用兼容的非默认端点时才增加 `DEEPSEEK_BASE_URL`。
4. 保证 TCP 端口 `8090`、`3081` 和 `3082` 可用。其他机器需要调用 A2A 时，在目标机防火墙中开放入站 TCP 3082；3081 仍仅使用回环地址。

不要发送源电脑的 `.env` 或生成的 `tmp/business-agent-dsh-home`。目标机启动脚本会创建自己的隔离 Profile 状态。

-----

<a id="build-and-verify"></a>
## 构建与验证

先在仓库根目录完成一次依赖安装和全量构建：

```powershell
pnpm install --frozen-lockfile
pnpm run build
```

随后可以独立验证服务和每个新增 DSH 包。任一命令失败都应停下，修复当前模块后再继续。

```powershell
pnpm --filter @deepseek-ai/dsh-business-workorder-service build
pnpm --filter @deepseek-ai/dsh-business-workorder-service test
pnpm --filter @deepseek-ai/dsh-business-workorder-host build
pnpm --filter @deepseek-ai/dsh-business-workorder-host test
pnpm --filter @deepseek-ai/dsh-business-workorder-ui build
pnpm --filter @deepseek-ai/dsh-business-workorder-ui test
pnpm --filter @deepseek-ai/dsh-business-workorder-debug build
pnpm --filter @deepseek-ai/dsh-business-workorder-debug test
pnpm --filter @deepseek-ai/dsh-business-agent build
pnpm --filter @deepseek-ai/dsh-business-agent test
pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build
pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test
pnpm --filter @deepseek-ai/dsh-business-agent-tests test
```

包测试不需要模型 API key。与 Agent 进行真实对话时需要目标机自己的 key。安装 Python 3.10+ 的机器还可以运行 `powershell -ExecutionPolicy Bypass -File business-agent\verify-a2a-python-v032.ps1`，由脚本创建隔离 venv 并验证精确的 `a2a-sdk==0.3.2` 路径。

-----

<a id="start-the-modules"></a>
## 启动各模块

运行时包含两个进程。mock 工单服务是一个独立进程；Host、右侧栏 UI 和调试插件虽然分别构建，但由 `business-agent` Bundle 在 DSH Web 进程中一次加载。

### 终端 1：mock 工单服务

运行启用了重置接口的开发服务：

```powershell
pnpm --filter @deepseek-ai/dsh-business-workorder-service start
```

服务监听 `http://127.0.0.1:8090`。在另一个终端执行验证：

```powershell
Invoke-RestMethod http://127.0.0.1:8090/health
Invoke-RestMethod http://127.0.0.1:8090/orders/WO-MVP-001
```

不需要 mock 重置能力时，使用 `node business-agent/workorder-service/bin/serve.js --port 8090`。浮动调试面板仍会显示，但由于调试接口不存在，重置操作会返回错误。

### 终端 2：DSH Web 和全部插件

通过受支持的 DSH 应用入口启动 Profile：

```powershell
powershell -ExecutionPolicy Bypass -File business-agent\start-dev.ps1 -ReplaceExisting
```

脚本不应打开默认浏览器时增加 `-NoOpen`。首次启动会创建隔离的 `business-agent` Profile，安装本地 Bundle，在 `http://127.0.0.1:3081/` 启动 Web，并在 `http://127.0.0.1:3082/` 启动 A2A。在已有目标机上替换包内容后，应先刷新 Profile 再启动：

```powershell
powershell -ExecutionPolicy Bypass -File business-agent\setup-profile.ps1 -Force
powershell -ExecutionPolicy Bypass -File business-agent\start-dev.ps1 -ReplaceExisting
```

需要内网直接调用时，让 Web 保持回环绑定，只暴露 A2A：

```powershell
powershell -ExecutionPolicy Bypass -File business-agent\start-dev.ps1 -NoOpen `
  -A2AHost 0.0.0.0 `
  -A2APublicBaseUrl http://192.168.1.10:3082
Invoke-RestMethod http://192.168.1.10:3082/.well-known/agent-card.json
```

应把示例 IP 替换为目标机稳定且可达的地址。容器在运行时设置 `A2A_LISTEN_HOST=0.0.0.0`、`A2A_LISTEN_PORT=3082` 和 `A2A_PUBLIC_BASE_URL`。Docker 和 Kubernetes 部署应声明 Compose 服务、Kubernetes Service、ingress、负载均衡器或稳定主机地址，而不是临时容器 IP。

不要用 `node` 直接启动 Host、UI 或调试插件。它们的 Cordis 服务和 Client 注入只有在组合后的 Profile 中才有效。

-----

<a id="end-to-end-debugging"></a>
## 端到端调测

下面的流程一起检查服务、MCP 工具、右侧栏、人工中断、Agent 唤醒投递和调试观察能力。

1. 打开 `http://127.0.0.1:3081/`，确认右侧栏展开后直接显示工单页面。
2. 展开浮动的 **Mock 调试**卡片并点击**重置工单**。卡片应显示已配置工单，以及为空或刚更新的唤醒记录列表。
3. 新建对话，让 Agent 查询并启动 `WO-MVP-001`。
4. 观察活动 1、2 自动完成。它们的进度事件会在唤醒链路中显示为已过滤决策，但不会进入 Agent 对话。
5. 活动 3 等待人工时，展开对应的唤醒记录。记录会显示服务事件、唤醒决策、目标 Session、Agent 状态、投递方式和实际发送给 Agent 的完整消息。
6. Agent 正在运行时通过 `inject()` 接收消息；Agent 空闲时通过 `followup()` 接收消息。
7. 让 Agent 启动活动 3，然后明确告知线下复核已经完成。Agent 通过 MCP 登记完成，活动 4、5 自动运行，右侧栏最终显示 `5/5` 和 `done`。
8. **刷新工单**只用于重新获取服务端最新快照，不会重置业务状态。

唤醒记录是保存在 DSH Host 进程中的开发观察数据。它们不会写入 Agent 上下文，当前 Bundle 配置最多保留 100 条，并在 DSH Web 进程重启后清空。

-----

<a id="troubleshooting"></a>
## 常见问题

| 现象 | 检查与处理 |
|---|---|
| 缺少 `apps/cli/lib/bin.js` 或 `apps/web/dist/index.html` | 在仓库根目录运行 `pnpm run build`。 |
| Bundle 无法解析某个 `workspace:^` 包 | 使用已记录版本的完整仓库，执行 `pnpm install --frozen-lockfile`，不要只复制 `lib/`。 |
| 端口 `8090`、`3081` 或 `3082` 被占用 | 停止旧进程。`start-dev.ps1 -ReplaceExisting` 只处理精确的 Web 和 A2A 监听端口。 |
| 其他机器无法获取 Agent Card | 检查防火墙是否允许 TCP 3082，使用声明 URL 而不是 `0.0.0.0`，并确认 `A2A_PUBLIC_BASE_URL` 是稳定且可达的地址。 |
| Web 已启动，但工单页面无法加载 | 先启动终端 1 并验证 `/health`，再确认 `business-agent/bundle/cordis.patch.yml` 中所有服务 URL 使用相同端口。 |
| 重置返回 HTTP 404 | 通过服务包的 `start` 脚本启动，或在直接启动命令中增加 `--debug`。 |
| Agent 无法调用工单工具 | 验证 `/mcp`，重新构建 Bundle，运行 `setup-profile.ps1 -Force`，然后重启 Web 进程。 |
| 重启后没有唤醒记录 | 重新产生一条工单事件。唤醒追踪数据刻意只保存在内存中。 |
| 右侧栏更新但 Agent 未收到通知 | 只有 `needsHuman: true` 的事件会投递；普通进度和完成事件会被过滤。 |

-----

## Dev Note

当前部署单元是 MVP 源码归档。尚未实现不包含源码、仅包含构建产物的安装包。
