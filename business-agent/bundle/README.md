# Business Agent bundle

English | [中文](README.zh.md)

This private Bundle adds the business work-order Host, Client, and development-only debug plugins to a Web-backed DSH Profile. Its `cordis.patch.yml` is the composition authority for business-agent runtime rows.

## Verify

```sh
pnpm --filter @deepseek-ai/dsh-business-agent build
pnpm --filter @deepseek-ai/dsh-business-agent test
```

The MVP Profile layers this Bundle after `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`. The patch mounts the official MCP Client against the local work-order service and fails startup when that service is unavailable. It disables the generic workspace-file and terminal right-Sidebar types, so opening the right Sidebar displays the work-order page directly. A collapsed floating debug card can reset the local mock order and inspect wake routing without adding controls to the work-order page.

## Model experience

The Bundle itself adds no model-visible content. Model-facing behavior belongs to its mounted plugins.

## Known limitations

The Bundle is private and intended only for this secondary-development workspace.
