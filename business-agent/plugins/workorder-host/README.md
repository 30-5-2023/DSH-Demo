# Business work-order Host plugin

English | [中文](README.zh.md)

This plugin observes successful top-level native work-order tools and keeps each order's primary Agent binding in process. Failed, nested, and Agent-less calls do not establish bindings.

## Verify

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-host build
pnpm --filter @deepseek-ai/dsh-business-workorder-host test
```

## Model experience

The plugin adds no model-visible content. Native work-order tools remain owned and exposed by the official MCP Client.

## Known limitations

The MVP keeps bindings in memory and does not yet consume business events or deliver wake messages.
