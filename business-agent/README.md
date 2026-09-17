# Business Agent workspace

English | [中文](README.zh.md)

This directory extends DeepSeek Harness (DSH) into a business-system scheduling agent. It is the single entry point for this fork's product design and implementation.

## Start here

| Need | Read |
|---|---|
| Architecture, product constraints, UI, and key sequences | [DESIGN.md](DESIGN.md) |
| Sequential implementation tasks and acceptance criteria | [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) |
| Work-order service runtime and API | [workorder-service/README.md](workorder-service/README.md) |
| Historical discussion | `_archive/` (not current design authority) |

## Scope

- Existing `packages/` and `apps/` behavior remains unchanged. New behavior is delivered through Cordis plugins, a Bundle, and a Profile patch.
- Business-agent implementation stays under this directory so upstream synchronization does not mix product-specific code into the harness.
- Agent scheduling uses documented extension points and native MCP tools. It does not modify the agent loop.

## Development order

Follow [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) strictly. Tasks 0 through 6 now form the verified MVP; Task 7 is the next increment after MVP acceptance. Persistence, production authentication, recovery, and multi-order navigation remain later work.

## Local entry points

The work-order service runs independently:

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-service build
pnpm --filter @deepseek-ai/dsh-business-workorder-service test
pnpm --filter @deepseek-ai/dsh-business-workorder-service start
```

Start the Web application with:

```powershell
powershell -File business-agent\start-dev.ps1
powershell -File business-agent\start-dev.ps1 -NoOpen
```

The launcher initializes the `business-agent` Profile from the shipped Web template and installs the local Bundle on first use. It keeps the development Profile under the ignored `tmp/business-agent-dsh-home` directory unless `-DshHome` selects another location. The Web application uses port `3081` by default. The work-order service uses `127.0.0.1:8090` by default.

## Layout

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
