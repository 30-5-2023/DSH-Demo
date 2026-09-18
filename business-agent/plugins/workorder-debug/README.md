---
description: "Development-only floating controls for resetting and inspecting the local mock work-order service without adding actions to the production work-order panel."
kind: "package-reference"
---

# Business work-order debug plugin

English | [中文](README.zh.md)

## Summary

This plugin adds a collapsed floating card to the DSH frame overlay for mock-only operations and wake-path inspection. It keeps debug actions separate from the read-only work-order page and the formal MCP write path. The card resets the configured mock order and shows the event, Host routing decision, and exact Agent message for each observed wake decision.

## Use this package

The target service must run with `--debug` or `createService({ debug: true })` for reset. The wake inspector reads a separate same-origin Host debug stream and does not depend on the mock service mutation endpoint.

```yaml
- name: '@deepseek-ai/dsh-business-workorder-debug'
  config:
    serviceUrl: http://127.0.0.1:8090
    orderId: WO-MVP-001
    traceLimit: 100
```

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-debug build
pnpm --filter @deepseek-ai/dsh-business-workorder-debug test
```

The browser asks for confirmation before `POST /debug/orders/:orderId/reset`. A successful reset publishes `order.reset` as a snapshot-refresh signal with `needsHuman: false`; it does not wake the agent. The Host stream at `/debug/business-workorder/wake-traces` retains at most `traceLimit` observations and distinguishes progress filtering, duplicate suppression, retained events, wake-budget suppression, `followup()`, and `inject()`. Delivery observations include the exact plugin-authored user message accepted by the Agent.

## Model Experience

None. The plugin contributes browser controls and no model-visible input.

## Known Limitations and Deferred Work

- The package is for the local mock service and is not an administration API.
- The card resets only the configured seed order.
- Debug actions are intentionally unavailable when the service is not started in debug mode.
- Wake observations are process-local and disappear when the DSH Host restarts.
