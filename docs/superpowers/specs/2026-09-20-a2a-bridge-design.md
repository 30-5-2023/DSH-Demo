# A2A Bridge Design

English | [中文](2026-09-20-a2a-bridge-design.zh.md)

Design status: approved for implementation planning.

## Summary

The Business Agent exposes one Agent2Agent (A2A) Protocol v1.0 agent and can call another A2A agent from a model-visible tool. Each inbound A2A context owns one durable DeepSeek Harness Session, so independent callers remain isolated and a caller can continue its conversation after a process restart. The implementation remains under `business-agent/` and does not modify `packages/` or `apps/`.

## Table of Contents

- [Goals](#goals)
- [Constraints](#constraints)
- [Selected approach](#selected-approach)
- [Architecture](#architecture)
- [Inbound protocol](#inbound-protocol)
- [Outbound tool](#outbound-tool)
- [Persistence and concurrency](#persistence-and-concurrency)
- [Security](#security)
- [Configuration](#configuration)
- [Failure behavior](#failure-behavior)
- [Testing](#testing)
- [Acceptance criteria](#acceptance-criteria)
- [References](#references)
- [Non-goals](#non-goals)

## Goals

The first release provides an A2A v1.0 JSON-RPC server with SSE streaming, a standard Agent Card, durable task lookup, task cancellation, and a model-facing client tool that accepts an Agent Card URL directly. It supports text input, structured JSON input, text output, and requested structured JSON output. Two local Business Agent instances with inbound authentication disabled can discover and call each other without a preconfigured remote-agent registry.

## Constraints

- The change extends the fork through a Cordis plugin and the Business Agent bundle. It does not change the DSH agent loop or upstream package APIs.
- One service instance exposes one configurable Agent Card backed by the current Business Agent composition.
- Every A2A `contextId` maps to one dedicated, durable DSH Session. Different contexts never share conversation history.
- The first release targets trusted loopback or intranet deployment. It permits direct HTTP(S) Agent Card URLs and does not block private addresses.
- Inbound Bearer authentication is optional on loopback and mandatory when the Web Server listens on all interfaces.
- The first release implements Agent Card discovery, `SendMessage`, `SendStreamingMessage`, `GetTask`, and `CancelTask`. Task listing, task resubscription, push notifications, extended Agent Cards, file parts, audio, video, gRPC, and HTTP+JSON are outside scope.

## Selected approach

One new `@deepseek-ai/dsh-business-a2a-bridge` package under `business-agent/plugins/a2a-bridge/` owns the A2A server adapter, remote client, durable A2A records, and `call_a2a_agent` tool. It uses the official `@a2a-js/sdk` for A2A v1.0 protocol types, request dispatch, client behavior, and SSE framing. A private Express router hosts the SDK's `agentCardHandler` and `jsonRpcHandler`; the router has no listener and runs only when the package's routes on the existing `ctx.webServer` invoke it. The package creates and resumes ordinary Sessions through `ctx.sessionController`, stores non-Session A2A records through `ctx.storageDomain`, and registers the outbound tool through `ctx.tools`.

The SDK `TaskStore` adapter implements the storage methods required by the library, while a public-operation allowlist rejects A2A methods outside the five operations approved for this release with the standard unsupported-operation error.

This approach keeps deployment in one process and preserves the fork's plugin-only extension rule. A separate gateway process would add deployment and state synchronization before either is needed. Extending `ctx.subagents` would change a public named-provider API even though this release requires a per-call URL, so that integration remains a possible later capability rather than part of this design.

## Architecture

```text
Remote A2A client
  |  A2A v1.0 JSON-RPC / SSE
  v
Business A2A Bridge
  |-- GET  /.well-known/agent-card.json
  |-- POST /a2a
  |-- A2A context/task persistence
  |-- DSH Session adapter
  `-- call_a2a_agent tool
          |
          |  Agent Card URL + A2A v1.0
          v
      Remote A2A agent

Business A2A Bridge -- ctx.sessionController --> Business Agent Session
Business A2A Bridge -- ctx.storageDomain -----> durable A2A records
Business A2A Bridge -- ctx.webServer --------> shared HTTP listener
```

The package has focused internal modules for server routing, Agent execution, remote calls, persistence, conversions, and tool registration. The Cordis entry module owns configuration validation and lifecycle cleanup. Route, tool, listener, stream, and storage registrations use Cordis effects and release to complete quiescence during unload.

The Agent Card advertises one agent. Its name, description, version, skills, public URL, and input/output media types come from validated plugin configuration. The Card advertises only JSON-RPC and the operations implemented by this release.

## Inbound protocol

### Agent discovery and authentication

`GET /.well-known/agent-card.json` always returns the public Agent Card. `POST /a2a` accepts A2A v1.0 JSON-RPC requests and uses the v1 media types handled by the official SDK. When `bearerTokenEnv` is configured, the Card declares the Bearer security scheme and requirement, and `/a2a` requires the exact token. Authentication failure returns HTTP 401 with `WWW-Authenticate: Bearer` before the SDK reads a protocol request.

### Context and Session creation

The first message without a `contextId` creates a server-minted `contextId`, `taskId`, and DSH `sessionId`. The bridge durably writes their relationship before it admits the prompt. A later message carrying the context restores the same Session through `ctx.sessionController`; an unknown context returns the A2A not-found failure and never creates a replacement Session.

The bridge creates the Session with the configured `agentPreset` when one is supplied. Otherwise it uses the composition's default preset and model selection. The bridge treats A2A-created Sessions as owned resources, does not expose their ids through A2A, and attributes every Task by its request and owning turn. Prompts submitted through another Host interface to those Session ids are outside supported behavior.

### Message conversion

An A2A Text Part becomes a DSH text content block. An A2A Data Part becomes a labeled, serialized JSON block that states that the remote value is untrusted data and not an instruction. Unsupported Part kinds fail the request before Session admission.

The default response mode emits A2A Text Parts. When the caller accepts `application/json`, the bridge adds a logged request instruction that requires one JSON object, parses the final assistant text strictly, and emits a Data Part. Invalid JSON fails the Task instead of silently returning text under a JSON media type.

### Task execution and streaming

Each accepted message gets a durable request identity derived from its A2A message and Task ids. The bridge correlates completion to the durable user-message event and its owning DSH turn. It collects assistant output from that turn until its `turn/end`; it does not treat process-wide Agent idle state as the result of one message.

`SendMessage` waits for the correlated turn to finish and returns the final Task. `SendStreamingMessage` emits submitted and working status, assistant chunks from the correlated turn, final Artifacts, and the terminal status. A disconnected SSE client stops receiving frames but does not cancel the Task. The caller uses `GetTask` to read the durable terminal result because task resubscription is outside scope.

### Cancellation

`CancelTask` is idempotent. Canceling a queued Task removes it from the bridge queue and records `canceled` without touching the Agent. Canceling the active Task calls `Agent.cancel()` for the context's current turn and records `canceled` after the activity settles. Canceling a terminal Task returns its existing state. Cancellation never deletes the context or Session.

## Outbound tool

The bridge registers one model-visible `call_a2a_agent` tool with these inputs:

| Field | Required | Meaning |
|---|---:|---|
| `agent_card_url` | yes | Absolute HTTP(S) URL of the remote Agent Card |
| `message` | yes | Text or JSON value to send |
| `context_id` | no | Remote context to continue |
| `stream` | no | Use streaming; defaults to `true` |
| `accepted_output_mode` | no | `text` or `json`; defaults to `text` |
| `timeout_ms` | no | Per-call timeout within the configured maximum |

The tool fetches and validates the supplied Agent Card for every call, selects its A2A v1.0 JSON-RPC interface, invokes the remote operation through the official client, and aggregates status, Parts, and Artifacts. The tool result returns the remote `contextId`, `taskId`, terminal state, output, and a safe diagnostic when the Task fails. A later tool call continues the remote conversation by passing the returned `contextId`.

If local tool cancellation occurs after the remote Task id is known, the client attempts `CancelTask` with a bounded cleanup deadline and then settles locally. The first release sends no outbound credentials. It never accepts an Authorization value as a model-visible tool argument or writes a credential to the Session log.

## Persistence and concurrency

The bridge declares one versioned storage domain with `contexts` and `tasks` tables. A context record stores `contextId`, `sessionId`, creation time, and update time. A Task record stores `taskId`, `contextId`, input message id, state, timestamps, final output or Artifact metadata, and a stable failure summary. Session conversation history remains solely in DSH Session persistence.

One in-memory scheduler serializes Tasks per context while allowing different contexts to run concurrently up to `maxConcurrentContexts`. Storage commits precede externally visible state changes. A repeated A2A message id resolves to its existing Task and never admits a duplicate prompt.

The bridge marks persisted `submitted` or `working` Tasks as failed with a stable host-interruption reason during startup because their in-memory execution ownership cannot survive a process restart. Their contexts and Sessions remain valid for later messages. Final Tasks remain queryable after restart.

## Security

- `agent_card_url` accepts only absolute `http:` and `https:` URLs, rejects embedded credentials and fragments, and enforces request and response byte limits.
- Direct private-network URLs are allowed by design. The deployment owner is responsible for network egress policy because this release targets a trusted intranet.
- Redirects may retain or strengthen the original scheme but never downgrade HTTPS to HTTP. Redirect count is bounded.
- Bearer tokens are loaded only from the configured environment variable. Comparisons use a timing-safe equality check, and logs never include Authorization values.
- The public Agent Card contains no credentials or sensitive implementation details; it declares authentication requirements when the A2A endpoint is protected.
- Remote Text and Data Parts are model-visible untrusted input. Conversion adds an explicit data label and never interpolates remote content into a system instruction.
- Public failures contain stable codes and safe summaries. Host logs retain correlation ids and internal exceptions without recording full prompts, credentials, or complete remote responses.

## Configuration

```yaml
- id: business-a2a-bridge
  name: '@deepseek-ai/dsh-business-a2a-bridge'
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
    bearerTokenEnv: BUSINESS_A2A_TOKEN
    requestTimeoutMs: 300000
    outboundTimeoutMs: 300000
    maxRequestBytes: 1048576
    maxResponseBytes: 4194304
    maxConcurrentContexts: 16
```

All deployment-varying limits are validated configuration fields. `publicBaseUrl` may be omitted for a loopback listener with a known port. It is required when the Web Server listens on `0.0.0.0`. `bearerTokenEnv` may be omitted on loopback and is required on `0.0.0.0`; the referenced environment value must be non-empty. The implementation uses the configured maximums as defaults and upper bounds for per-call values.

## Failure behavior

Invalid authentication, media types, protocol data, Parts, URLs, and size limits fail before model execution. Unknown contexts and Tasks return A2A not-found failures. Session creation, resume, model, tool, timeout, and conversion failures move an accepted Task to `failed`; any already committed partial Artifact remains attached. Timeout also cancels the active Agent turn before the Task settles.

The bridge uses the official SDK's standard A2A error mapping for protocol failures. Internal DSH errors map to stable bridge error codes and safe messages. Cleanup failures are logged independently and never rewrite a previously committed terminal Task state.

## Testing

Unit tests cover configuration, authentication, URL validation, Part conversion, JSON output parsing, state transitions, idempotency, persistence recovery, error mapping, and HMR cleanup. Protocol integration tests use the official A2A client against the real bridge with the real Web Server, Session controller, Agent loop, and storage; only the LLM is scripted. Outbound tests use a temporary official-SDK A2A server and verify synchronous, streaming, continuation, cancellation, timeout, size-limit, and failure behavior.

A real Loader composition test boots the Business Agent profile and drives A2A through the built entry path. A keyless recorded-session scenario owns the model-visible `call_a2a_agent` tool schema, call, result, and Session events. Package and bundle documentation update with the implementation, and the non-trivial change adds a proposed Agent Note before implementation and promotes it when the behavior ships.

Network fixtures bind `127.0.0.1:0` and read the assigned address after the listening event. Each test owns a temporary storage root and unique ids. Tests synchronize on explicit events or barriers, never fixed sleeps; cleanup awaits SSE closure, HTTP server closure, Agent settlement, and storage closure. Tests avoid process-global `fetch`, current-directory, timer, and environment mutation.

## Acceptance criteria

- An official A2A v1.0 client discovers the configured Agent Card and completes synchronous and streaming messages against the Business Agent profile.
- A second message with the same context uses the same DSH Session, while a different context has independent history.
- `GetTask` returns terminal output after a Host restart, and the same context accepts another message after restart.
- `CancelTask` cancels queued and active work without deleting the context.
- With loopback inbound authentication disabled, one Business Agent instance calls another by passing only its Agent Card URL and message to `call_a2a_agent`.
- The outbound tool returns identifiers and output that let the model continue a remote context.
- Focused tests, the real composition test, the recorded-session snapshot, type checking, lint, build, and documentation checks pass.

## References

- [A2A Protocol v1.0 specification](https://a2a-protocol.org/v1.0.0/specification/)
- [Official A2A JavaScript SDK](https://github.com/a2aproject/a2a-js)

## Non-goals

The first release does not add a remote-agent registry, dynamic Agent Card management, outbound credential transport, public-Internet hardening, task push notifications, task listing, stream resubscription, file or media transfer, multiple protocol bindings, a `ctx.subagents` provider, UI controls, or cross-process execution coordination. These capabilities require separate designs after the core A2A path has production evidence.
