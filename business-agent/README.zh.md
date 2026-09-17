# 业务 Agent 工作区

[English](README.md) | 中文

本目录把 DeepSeek Harness（DSH）扩展为业务系统调度 Agent，是本分支产品设计与实现的唯一入口。

## 从这里开始

| 需要了解的内容 | 文档 |
|---|---|
| 架构、产品约束、页面与关键时序 | [DESIGN.md](DESIGN.md) |
| 串行开发任务与验收标准 | [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) |
| 工单服务运行方式与 API | [workorder-service/README.zh.md](workorder-service/README.zh.md) |
| 历史讨论 | `_archive/`（不是当前设计依据） |

## 范围

- 不改变现有 `packages/` 与 `apps/` 的行为。新行为通过 Cordis 插件、Bundle 与 Profile patch 交付。
- 业务 Agent 的实现集中在本目录，避免上游同步时把产品专用代码混入底座。
- Agent 调度使用已记录的扩展点与原生 MCP 工具，不修改 agent loop。

## 开发顺序

严格按照 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) 执行。Task 0 至 Task 6 已构成通过验证的 MVP；MVP 验收后，下一个增量是 Task 7。持久化、生产认证、恢复与多工单导航仍属于后续工作。

## 本地入口

工单服务可以独立运行：

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-service build
pnpm --filter @deepseek-ai/dsh-business-workorder-service test
pnpm --filter @deepseek-ai/dsh-business-workorder-service start
```

用以下命令启动 Web 应用：

```powershell
powershell -File business-agent\start-dev.ps1
powershell -File business-agent\start-dev.ps1 -NoOpen
```

启动脚本会在首次使用时根据内置 Web 模板初始化 `business-agent` Profile，并安装本地 Bundle。除非通过 `-DshHome` 选择其他位置，否则开发 Profile 保存在已忽略的 `tmp/business-agent-dsh-home` 目录。Web 应用默认使用端口 `3081`。工单服务默认使用 `127.0.0.1:8090`。

## 目录

```text
DESIGN.md              Current design authority
DEVELOPMENT_PLAN.md    Sequential tasks and acceptance criteria
bundle/                Business Bundle and Profile patch
plugins/               Host and Client plugins
workorder-service/     Independent mock business system
tests/                 Cross-package and vertical-slice tests
start-dev.ps1          Local Web launcher
_archive/              Historical discussion, not current design authority
```
