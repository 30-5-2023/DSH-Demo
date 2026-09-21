# Business Agent bundle

English | [中文](README.zh.md)

This private Bundle adds the business work-order Host, Client, development-only debug plugins, and A2A bridge to a Web-backed DSH Profile. Its `cordis.patch.yml` is the composition authority for business-agent runtime rows.

## Verify

```sh
pnpm --filter @deepseek-ai/dsh-business-agent build
pnpm --filter @deepseek-ai/dsh-business-agent test
```

The MVP Profile layers this Bundle after `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`. The patch mounts the official MCP Client against the local work-order service and fails startup when that service is unavailable. It disables the generic workspace-file and terminal right-Sidebar types, so opening the right Sidebar displays the work-order page directly. A collapsed floating debug card can reset the local mock order and inspect wake routing without adding controls to the work-order page.

The patch also mounts `@deepseek-ai/dsh-business-a2a-bridge`. Its public URL defaults from the active loopback listener, so `-Port 3099` advertises `http://127.0.0.1:3099/a2a` without editing the Bundle. Discovery remains at `/.well-known/agent-card.json`; the model receives `call_a2a_agent` for URL-only outbound calls.

## Model experience

The Bundle itself adds no model-visible content. The mounted A2A bridge contributes `call_a2a_agent`; other model-facing behavior belongs to the remaining mounted plugins.

## Known limitations

The Bundle is private and intended only for this secondary-development workspace. Its Web launcher binds loopback only; network exposure needs a deployment composition that supplies the shared Host listener and follows the A2A bridge's public-URL and Bearer-token rules.
