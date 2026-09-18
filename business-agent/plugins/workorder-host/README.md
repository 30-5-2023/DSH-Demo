# Business work-order Host plugin

English | [中文](README.zh.md)

This plugin binds successful top-level native work-order tools to their calling Session and consumes the work-order SSE feed. It delivers only new `needsHuman` blocking rounds to the bound live Agent, using `followup()` while idle and `inject()` while running. After each routing decision it emits a Host-local `business-workorder/wake-trace` observation for development tooling; observer failure is logged and cannot interrupt message delivery.

## Verify

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-host build
pnpm --filter @deepseek-ai/dsh-business-workorder-host test
```

## Model experience

The official MCP Client exposes the native work-order tools. A blocking event adds one plugin-originated user message whose escaped business fields are explicitly marked as untrusted data; ordinary progress does not enter model context.

## Known limitations

The MVP keeps bindings, event cursors, pending notices, and wake budgets in memory. Reconnection starts at the live SSE position, so a service outage can lose events until persistent replay or snapshot resynchronization is added.
