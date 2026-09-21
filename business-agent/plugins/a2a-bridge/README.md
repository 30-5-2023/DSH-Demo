---
description: "Configuration and Agent Card contracts for exposing a Business Agent through A2A Protocol v1.0 and calling another A2A agent by URL."
kind: "package-reference"
---

# Business A2A bridge

English | [中文](README.zh.md)

## Summary

This package exposes a Business Agent through A2A Protocol v1.0 and lets that agent call another A2A agent from its Agent Card URL. It mounts discovery and JSON-RPC on the shared Host listener, executes inbound work through ordinary durable Sessions, and registers the model-visible `call_a2a_agent` tool. Local development defaults to loopback; listening on every interface requires an explicit public URL and inbound Bearer token.

## Table of Contents

- [Use this package](#use-this-package)
- [Operate two local agents](#operate-two-local-agents)
- [Expose an intranet listener](#expose-an-intranet-listener)
- [Operating limits](#operating-limits)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load the plugin in a `dsh` profile. With the example below, discovery is available at `http://127.0.0.1:3081/.well-known/agent-card.json` and A2A JSON-RPC is available at `http://127.0.0.1:3081/a2a`.

```yaml
- name: '@deepseek-ai/dsh-business-a2a-bridge'
  config:
    route: /a2a
    publicBaseUrl: http://127.0.0.1:3081
    agent:
      name: Business Agent
      description: Internal business workflow agent
      version: 0.1.0
      defaultInputModes: [text/plain, application/json]
      defaultOutputModes: [text/plain, application/json]
      skills:
        - id: business-workflows
          name: Business Workflows
          description: Handle configured internal business workflows
          tags: [business]
```

| Field | Default | Meaning |
|---|---|---|
| `route` | `/a2a` | Absolute non-root path reserved for A2A JSON-RPC |
| `publicBaseUrl` | loopback listener URL | Public HTTP(S) base used in the Agent Card; required on `0.0.0.0` |
| `bearerTokenEnv` | none on loopback | Environment variable containing the inbound token; required on `0.0.0.0` |
| `agent` | required | Agent identity, modes, and at least one advertised skill |
| request and response limits | bounded defaults | Positive timeout, byte, and concurrent-context limits |

The agent calls another compatible agent with `call_a2a_agent`. Supply only the remote Agent Card URL and a text or JSON message; pass a returned `context_id` to continue the remote conversation. Streaming defaults to enabled, output defaults to text, and `timeout_ms` is capped by `outboundTimeoutMs`. The first release deliberately has no outbound authentication field, so the remote URL must be reachable without credentials.

Verify the bridge with `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test`.

-----

<a id="operate-two-local-agents"></a>
## Operate two local agents

Build the workspace and start the work-order service once. Then open two PowerShell terminals and give each Business Agent an isolated `DSH_HOME` and listener port:

```powershell
powershell -File business-agent\start-dev.ps1 -NoOpen -Port 3081 -DshHome tmp\a2a-agent-a
powershell -File business-agent\start-dev.ps1 -NoOpen -Port 3082 -DshHome tmp\a2a-agent-b
```

Agent A publishes `http://127.0.0.1:3081/.well-known/agent-card.json`; Agent B publishes `http://127.0.0.1:3082/.well-known/agent-card.json`. Their JSON-RPC routes are the corresponding `/a2a` URLs. A caller starts a remote conversation with the Card URL and message, then passes the returned `context_id` on later `call_a2a_agent` calls. Each process owns its Sessions and bridge records under its selected `DSH_HOME`.

The Card URL is the only discovery input. Do not pass the JSON-RPC URL to `agent_card_url`, and do not append tokens, credentials, query strings, or fragments. The client fetches the Card again for every call so interface changes take effect without restarting the caller.

Stop each process with `Ctrl+C`. Shutdown stops accepting new contexts, aborts queued and active execution, waits for active work to settle, closes streams, and closes the bridge store. A later start marks Tasks that were still non-terminal at process loss as failed while retaining completed Tasks and context-to-Session mappings.

-----

<a id="expose-an-intranet-listener"></a>
## Expose an intranet listener

The shipped Web launcher intentionally binds loopback. An intranet deployment composition may bind the shared Host listener to `0.0.0.0`, but the bridge then refuses to load unless `publicBaseUrl` names the address peers use and `bearerTokenEnv` names an environment variable containing a non-empty token:

```powershell
$env:BUSINESS_A2A_TOKEN = '<deployment-secret>'
```

```yaml
publicBaseUrl: http://10.20.30.40:3081
bearerTokenEnv: BUSINESS_A2A_TOKEN
```

The Agent Card stays public. Requests to `/a2a` must carry `Authorization: Bearer <deployment-secret>`. Keep the token in the process environment or deployment secret store; never place it in `cordis.yml`, an Agent Card URL, a prompt, or `call_a2a_agent`. This first release has no outbound authentication, so a bridge that requires a token is callable only by a peer whose A2A client supplies that header outside model-visible input.

Terminate TLS at the intranet ingress or reverse proxy when the network requires confidentiality. The bridge accepts HTTP and HTTPS URLs and does not provision certificates.

-----

<a id="operating-limits"></a>
## Operating limits

| Limit | Default | Allowed maximum | Effect |
|---|---:|---:|---|
| `requestTimeoutMs` | 300000 ms | 1800000 ms | Bounds one inbound Session turn |
| `outboundTimeoutMs` | 300000 ms | 1800000 ms | Bounds Card discovery and one outbound call |
| `maxRequestBytes` | 1048576 bytes | 67108864 bytes | Rejects oversized inbound JSON-RPC bodies |
| `maxResponseBytes` | 4194304 bytes | 67108864 bytes | Rejects oversized Card and remote response bodies |
| `maxConcurrentContexts` | 16 | 256 | Bounds contexts executing concurrently; one context remains serial |
| outbound redirects | 4 | fixed | Rejects excessive, unsafe, and HTTPS-to-HTTP redirects |

The bridge preserves context and Task records, not an unbounded protocol archive. Monitor Host availability, request latency, timeout failures, response-size failures, and the configured storage domain. Safe protocol and tool failures contain stable codes and short messages; they omit tokens, prompts, reasoning, tool calls, and full remote bodies.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Configuration resolution validates the deployment before routes are mounted. The Card builder derives its single A2A JSON-RPC interface from the normalized public URL and route, advertises streaming without push notifications, and describes inbound Bearer authentication without copying the secret into discovery output. Inbound messages create or continue durable Sessions, and durable bridge records preserve A2A context and Task lookup. Outbound calls fetch a fresh Agent Card, select its A2A v1.0 JSON-RPC interface, enforce redirect, timeout, and response-byte limits, and attempt one bounded remote cancellation when a locally canceled call already has a Task id.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [A2A bridge design](../../../../docs/superpowers/specs/2026-09-20-a2a-bridge-design.md) — approved protocol, persistence, lifecycle, and security decisions
- [Business Agent design](../../../DESIGN.md) — composition and business-system integration model
- [Subagent capability decision](../../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md) — local and product-process delegation model

-----

<a id="model-experience"></a>
## Model Experience

The model receives `call_a2a_agent` with exactly six fields: `agent_card_url`, `message`, optional `context_id`, optional `stream`, optional `accepted_output_mode`, and optional `timeout_ms`. Results contain the remote context id, Task id, state, output, and only a stable diagnostic when the remote Task fails.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Discovery supports one Agent Card and one JSON-RPC interface per process.
- Outbound authentication, per-user authorization, push notifications, task listing, stream resubscription, files, media, gRPC, and HTTP+JSON are outside the approved scope.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
