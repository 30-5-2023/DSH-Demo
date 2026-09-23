---
description: "Configuration and Agent Card contracts for exposing and calling A2A v1.0 and v0.3 JSON-RPC agents."
kind: "package-reference"
---

# Business A2A bridge

English | [中文](README.zh.md)

## Summary

This package exposes a Business Agent through A2A Protocol v1.0 and v0.3 and lets that agent call either protocol generation from an Agent Card URL. It serves discovery, JSON-RPC, and expiring file downloads from an optional A2A-only listener, executes inbound work through durable Sessions, and registers model-visible tools for remote calls and explicit file publication. Local development binds loopback; intranet deployment injects a reachable public URL at runtime.

## Table of Contents

- [Use this package](#use-this-package)
- [Exchange files](#exchange-files)
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

Load the plugin in a `dsh` profile. With the example below, discovery is available at `http://127.0.0.1:3082/.well-known/agent-card.json` and A2A JSON-RPC is available at `http://127.0.0.1:3082/a2a`.

```yaml
- name: '@deepseek-ai/dsh-business-a2a-bridge'
  config:
    route: /a2a
    listener:
      host: 127.0.0.1
      port: 3082
    agent:
      name: Business Agent
      description: Internal business workflow agent
      version: 0.1.0
      defaultInputModes: [text/plain, application/json, application/octet-stream]
      defaultOutputModes: [text/plain, application/json, application/octet-stream]
      skills:
        - id: business-workflows
          name: Business Workflows
          description: Handle configured internal business workflows
          tags: [business]
```

| Field | Default | Meaning |
|---|---|---|
| `route` | `/a2a` | Absolute non-root path reserved for A2A JSON-RPC |
| `listener.host` | `127.0.0.1` in the Bundle | A2A-only bind address: `127.0.0.1` or `0.0.0.0` |
| `listener.port` | `3082` in the Bundle | Dedicated A2A listener port from 1 through 65535 |
| `publicBaseUrl` | listener loopback URL | HTTP(S) base advertised in the Agent Card; required on `0.0.0.0` and must never advertise `0.0.0.0` |
| `bearerTokenEnv` | none | Optional environment variable containing the inbound Bearer token |
| `agent` | required | Agent identity, modes, and at least one advertised skill |
| `inlineFileMaxBytes` | 1048576 bytes | Maximum file size encoded inline as v0.3 `FileWithBytes` |
| `maxFileBytes` | 268435456 bytes | Maximum file size admitted, fetched, published, sent, or materialized |
| `fileRetentionMs` | 86400000 ms | Lifetime of an opaque hosted-file URL |
| `fileUrlAllowedOrigins` | `[]` | Extra exact HTTP(S) origins allowed for inbound URI files and remote output files |
| `publishFileAllowedRoots` | `[]` | Absolute roots allowed in addition to the Session workspace for local publication and outbound files |
| request and response limits | bounded defaults | Positive timeout, byte, and concurrent-context limits |

The agent calls another compatible agent with `call_a2a_agent`. Supply the remote Agent Card URL and a text or JSON message, optionally add local `files`, and pass a returned `context_id` to continue the remote conversation. Streaming defaults to enabled, output defaults to text, and `timeout_ms` is capped by `outboundTimeoutMs`. The tool has no outbound authentication field, so the remote URL must be reachable without credentials.

Verify the bridge with `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test`.
Run `powershell -ExecutionPolicy Bypass -File business-agent\verify-a2a-python-v032.ps1` to create an isolated venv and verify both directions against exact Python `a2a-sdk==0.3.2`.

-----

<a id="exchange-files"></a>
## Exchange files

Python `a2a-sdk==0.3.2` represents files as `FilePart` values containing `FileWithBytes` or `FileWithUri`. The bridge sends files at or below `inlineFileMaxBytes` as canonical base64 bytes and sends larger files as opaque URLs from the dedicated listener. Without a dedicated listener, inline files remain available but a larger file fails with `A2A_FILE_URL_UNAVAILABLE` instead of returning an unreachable URL. A file larger than `maxFileBytes` is rejected before it reaches a Session or result.

Inbound URI files must use an exact origin in `fileUrlAllowedOrigins`. For files returned by a called agent, the Agent Card origin is also allowed. Every redirect is checked again; credentials, fragments, HTTPS-to-HTTP downgrade, excess redirects, timeouts, cancellation, and measured size overflow fail without exposing a partial local result.

`publish_a2a_file` resolves `path` against the active Session workspace or `publishFileAllowedRoots`, snapshots the bytes into DSH attachments, and appends the file after the normal text or JSON output in the completing Task Artifact. `call_a2a_agent.files` applies the same local-path rules and preserves message/file order. Returned file Parts appear in `result.files` as local absolute `path`, `name`, `mime_type`, `bytes`, and `artifact_id`; the path belongs to the calling deployment and is not a path on the remote agent.

Large output URLs use `GET` or `HEAD` at `${route}/files/:token`, reject range requests, and expire after `fileRetentionMs`. The URL remains usable across a process restart while its metadata and attachment still exist. Another machine receives the bytes over HTTP from `publicBaseUrl`; it never receives access to the source filesystem path.

The opaque token authorizes the download in the current no-auth research deployment. Keep the listener on a trusted network, avoid logging URLs, and use a separate production authorization design before exposing downloads to an untrusted network.

-----

<a id="operate-two-local-agents"></a>
## Operate two local agents

Build the workspace and start the work-order service once. Then open two PowerShell terminals and give each Business Agent an isolated `DSH_HOME` and listener port:

```powershell
powershell -File business-agent\start-dev.ps1 -NoOpen -Port 3081 -A2APort 3082 -DshHome tmp\a2a-agent-a
powershell -File business-agent\start-dev.ps1 -NoOpen -Port 3091 -A2APort 3092 -DshHome tmp\a2a-agent-b
```

Agent A publishes `http://127.0.0.1:3082/.well-known/agent-card.json`; Agent B publishes `http://127.0.0.1:3092/.well-known/agent-card.json`. Their JSON-RPC routes are the corresponding `/a2a` URLs. A caller starts a remote conversation with the Card URL and message, then passes the returned `context_id` on later `call_a2a_agent` calls. Each process owns its Sessions and bridge records under its selected `DSH_HOME`.

The Card URL is the only discovery input. Do not pass the JSON-RPC URL to `agent_card_url`, and do not append tokens, credentials, query strings, or fragments. The client fetches the Card again for every call so interface changes take effect without restarting the caller.

Stop each process with `Ctrl+C`. Shutdown stops new listener connections and context admission, waits for admitted HTTP responses and active work to settle, closes streams, and closes the bridge store. A later start marks Tasks that were still non-terminal at process loss as failed while retaining completed Tasks and context-to-Session mappings.

-----

<a id="expose-an-intranet-listener"></a>
## Expose an intranet listener

The Web listener remains on `127.0.0.1:3081`. The following command binds only the dedicated A2A listener to every interface and advertises an address that another intranet machine can reach:

```powershell
powershell -File business-agent\start-dev.ps1 -NoOpen `
  -A2AHost 0.0.0.0 `
  -A2APublicBaseUrl http://192.168.1.10:3082
```

`0.0.0.0` is a bind address, not a client URL. Set `A2A_PUBLIC_BASE_URL` at runtime to a stable host address, DNS name, Docker Compose service, Kubernetes Service, ingress, or load balancer that peers can resolve. The research listener permits direct unauthenticated calls; set `bearerTokenEnv` when a deployment supplies a token outside model-visible input.

The Business Bundle reads `A2A_INLINE_FILE_MAX_BYTES`, `A2A_MAX_FILE_BYTES`, and `A2A_FILE_RETENTION_MS` as integer overrides. It reads `A2A_FILE_URL_ALLOWED_ORIGINS` and `A2A_PUBLISH_FILE_ALLOWED_ROOTS` as comma-separated lists. Docker or Kubernetes must inject these values and `A2A_PUBLIC_BASE_URL` at runtime; do not store a machine or pod IP in the image.

Verify discovery from another machine with `Invoke-RestMethod http://192.168.1.10:3082/.well-known/agent-card.json`. Open TCP 3082 in the host firewall when needed. Terminate TLS at an ingress or reverse proxy when the network requires confidentiality; the bridge accepts HTTP and HTTPS URLs and does not provision certificates.

-----

<a id="operating-limits"></a>
## Operating limits

| Limit | Default | Allowed maximum | Effect |
|---|---:|---:|---|
| `requestTimeoutMs` | 300000 ms | 1800000 ms | Bounds one inbound Session turn |
| `outboundTimeoutMs` | 300000 ms | 1800000 ms | Bounds Card discovery and one outbound call |
| `maxRequestBytes` | 2097152 bytes | 67108864 bytes | Rejects oversized inbound JSON-RPC bodies |
| `maxResponseBytes` | 4194304 bytes | 67108864 bytes | Rejects oversized Card and remote response bodies |
| `maxConcurrentContexts` | 16 | 256 | Bounds contexts executing concurrently; one context remains serial |
| `inlineFileMaxBytes` | 1048576 bytes | 4294967296 bytes | Selects inline bytes at or below the threshold and, with a dedicated listener, hosted URI above it |
| `maxFileBytes` | 268435456 bytes | 4294967296 bytes | Rejects a file when measured bytes exceed the limit |
| `fileRetentionMs` | 86400000 ms | 2592000000 ms | Expires hosted file links; minimum is 60000 ms |
| outbound redirects | 4 | fixed | Rejects excessive, unsafe, and HTTPS-to-HTTP redirects |

The bridge preserves context and Task records, not an unbounded protocol archive. Monitor Host availability, request latency, timeout failures, response-size failures, and the configured storage domain. Safe protocol and tool failures contain stable codes and short messages; they omit tokens, prompts, reasoning, tool calls, and full remote bodies.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Configuration resolution validates the listener, advertised address, exact file origins, absolute publication roots, and related size invariants before binding. The Card and JSON-RPC handlers use the official SDK compatibility layer to negotiate v1.0 and v0.3 while the bridge keeps v1.0 internal types. Every admitted file is snapshotted through the attachment service; a separate storage domain owns only opaque link metadata and expiry. The private Express application exposes downloads only on the dedicated listener. Inbound messages create or continue durable Sessions; outbound calls select the advertised protocol interface and retain redirect, timeout, size, and bounded-cancellation policies.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [A2A bridge design](../../../../docs/superpowers/specs/2026-09-20-a2a-bridge-design.md) — approved protocol, persistence, lifecycle, and security decisions
- [A2A v0.3 and LAN design](../../../../docs/superpowers/specs/2026-09-21-a2a-v03-lan-compatibility-design.md) — compatibility, listener isolation, and runtime address decisions
- [A2A v0.3 file design](../../../../docs/superpowers/specs/2026-09-22-a2a-v03-file-artifacts-design.md) — file Parts, attachment ownership, hosted links, and transfer policy
- [Business Agent design](../../../DESIGN.md) — composition and business-system integration model
- [Subagent capability decision](../../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md) — local and product-process delegation model

-----

<a id="model-experience"></a>
## Model Experience

The model receives `call_a2a_agent` with `agent_card_url`, `message`, optional `files`, optional `context_id`, optional `stream`, optional `accepted_output_mode`, and optional `timeout_ms`. Results contain the remote context id, Task id, state, text or JSON output, materialized file metadata and paths, and only a stable diagnostic when the remote Task fails. The model also receives `publish_a2a_file`; it returns attachment metadata without embedding file bytes or a download token.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Discovery supports one Agent Card with v1.0 and v0.3 JSON-RPC interfaces per process.
- Outbound authentication, per-user authorization, push notifications, task listing, stream resubscription, v1.0 file compatibility, non-file media, resumable downloads, gRPC, and HTTP+JSON are outside the approved scope.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
