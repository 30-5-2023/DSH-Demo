# Business Agent workspace

English | [中文](README.zh.md)

This directory extends DeepSeek Harness (DSH) into a business-system scheduling agent. It is the single entry point for this fork's product design and implementation.

## Start here

| Need | Read |
|---|---|
| Architecture, product constraints, UI, and key sequences | [DESIGN.md](DESIGN.md) |
| Sidebar, workorder, wake-router, and Agent integration contracts and replacement points | [INTEGRATION_CONTRACTS.md](INTEGRATION_CONTRACTS.md) |
| Activity-independent work-order interaction forms and the DSH round trip | [FORM_DESIGN.md](FORM_DESIGN.md) |
| Sequential implementation tasks and acceptance criteria | [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) |
| Moving the MVP to another computer and verifying it | [migration/README.md](migration/README.md) |
| Work-order service runtime and API | [workorder-service/README.md](workorder-service/README.md) |
| A2A endpoints, configuration, and operating limits | [plugins/a2a-bridge/README.md](plugins/a2a-bridge/README.md) |
| Historical discussion | `_archive/` (not current design authority) |

## Scope

- Existing `packages/` and `apps/` behavior remains unchanged. New behavior is delivered through Cordis plugins, a Bundle, and a Profile patch.
- Business-agent implementation stays under this directory so upstream synchronization does not mix product-specific code into the harness.
- Agent scheduling uses documented extension points and native MCP tools. It does not modify the agent loop.

## Development order

Follow [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) strictly. Tasks 0 through 6 now form the verified MVP; after MVP acceptance, freeze the [production integration contracts](INTEGRATION_CONTRACTS.md) before Task 7. Persistence, production authentication, recovery, and multi-order navigation remain later work.

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
powershell -File business-agent\start-dev.ps1 -NoOpen `
  -A2AHost 0.0.0.0 `
  -A2APublicBaseUrl http://192.168.1.10:3082
```

The launcher initializes the `business-agent` Profile from the shipped Web template and installs the local Bundle on first use. It keeps the development Profile under the ignored `tmp/business-agent-dsh-home` directory unless `-DshHome` selects another location. The Web application stays on `127.0.0.1:3081`; the dedicated A2A listener uses `127.0.0.1:3082` by default. The work-order service uses `127.0.0.1:8090` by default.

The same process exposes its public Agent Card at `http://127.0.0.1:3082/.well-known/agent-card.json` and A2A v1.0/v0.3 JSON-RPC at `http://127.0.0.1:3082/a2a`. The three-line LAN command binds only A2A to `0.0.0.0`; replace the example IP with a runtime address that callers can reach. Give another compatible agent the Agent Card URL; this agent can call that deployment with `call_a2a_agent`, continue an `input-required` Task by returning its `task_id` with an answer, send workspace files through optional `files`, and receive file outputs as local attachment paths. An inbound A2A Task can return an explicit local file with `publish_a2a_file`. See the [A2A bridge reference](plugins/a2a-bridge/README.md) for question schemas, Task lookup, continuation and restart semantics, v0.3 file types, thresholds, URI allowlists, download lifetime, address injection, authentication limits, and container deployment.

## Layout

```text
DESIGN.md              Current design authority
INTEGRATION_CONTRACTS.md  Cross-module interfaces and replacement points
FORM_DESIGN.md         Agent activity form protocol and DSH round trip
DEVELOPMENT_PLAN.md    Sequential tasks and acceptance criteria
bundle/                Business Bundle and Profile patch
plugins/               Host and Client plugins
workorder-service/     Independent mock business system
tests/                 Cross-package and vertical-slice tests
start-dev.ps1          Local Web launcher
_archive/              Historical discussion, not current design authority
```
