# Business Agent bundle

English | [中文](README.zh.md)

This private Bundle adds the business work-order Host, Client, development-only debug plugins, and A2A bridge to a Web-backed DSH Profile. Its `cordis.patch.yml` is the composition authority for business-agent runtime rows.

## Verify

```sh
pnpm --filter @deepseek-ai/dsh-business-agent build
pnpm --filter @deepseek-ai/dsh-business-agent test
```

The MVP Profile layers this Bundle after `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`. The patch mounts the official MCP Client against the local work-order service and fails startup when that service is unavailable. It disables the generic workspace-file and terminal right-Sidebar types, so opening the right Sidebar displays the work-order page directly. A collapsed floating debug card can reset the local mock order and inspect wake routing without adding controls to the work-order page.

The patch also mounts `@deepseek-ai/dsh-business-a2a-bridge`. The Web listener stays on `127.0.0.1:3081`, while the A2A-only listener defaults to `127.0.0.1:3082`. `A2A_LISTEN_HOST`, `A2A_LISTEN_PORT`, and `A2A_PUBLIC_BASE_URL` supply deployment values at runtime, so an image does not contain a host or container IP. Discovery remains at `/.well-known/agent-card.json`; the model receives `call_a2a_agent` for URL-only v1.0 or v0.3 calls.

## Model experience

The Bundle itself adds no model-visible content. The mounted A2A bridge contributes `call_a2a_agent`; other model-facing behavior belongs to the remaining mounted plugins.

## Known limitations

The Bundle is private and intended only for this secondary-development workspace. Its Web launcher binds loopback only. Direct intranet exposure binds the dedicated A2A listener to `0.0.0.0` and supplies a reachable public URL; authentication remains optional for the research deployment.
