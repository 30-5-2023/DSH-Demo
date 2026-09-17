# Business work-order Host plugin

English | [中文](README.zh.md)

This plugin owns DSH session/order binding, business-event consumption, and wake delivery. Task 2 exposes only a lifecycle marker; Tasks 3 and 4 add native-tool observation and the wake adapter.

## Verify

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-host build
pnpm --filter @deepseek-ai/dsh-business-workorder-host test
```

## Model experience

The Task 2 marker adds no model-visible content. Task 4 wake messages are the first model-visible behavior and must be reconstructable from the Session log.

## Known limitations

The MVP keeps bindings, cursors, and wake budgets in memory. Restart recovery belongs to Task 7.
