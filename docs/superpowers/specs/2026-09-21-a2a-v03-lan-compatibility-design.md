# A2A v0.3 Compatibility and LAN Listener Design

English | [中文](2026-09-21-a2a-v03-lan-compatibility-design.zh.md)

Design status: awaiting written-spec approval.

## Summary

The Business Agent interoperates in both directions with agents built on Python `a2a-sdk==0.3.2` while retaining A2A v1.0 as its primary protocol. An optional dedicated listener exposes only A2A discovery and JSON-RPC routes on an intranet-facing address, while the DSH Web listener remains on loopback. Deployments inject the stable address advertised in the Agent Card at runtime instead of baking a machine or container IP into the image.

This design extends the existing [A2A Bridge design](2026-09-20-a2a-bridge-design.md). It supersedes that document only where protocol versions, listener ownership, network authentication requirements, configuration, and related tests differ.

## Table of Contents

- [Goals](#goals)
- [Constraints](#constraints)
- [Selected approach](#selected-approach)
- [Protocol compatibility](#protocol-compatibility)
- [Dedicated listener](#dedicated-listener)
- [Configuration](#configuration)
- [Lifecycle and failures](#lifecycle-and-failures)
- [Testing](#testing)
- [Acceptance criteria](#acceptance-criteria)
- [References](#references)
- [Non-goals](#non-goals)

<a id="goals"></a>
## Goals

- A Python client using `a2a-sdk==0.3.2` can discover this Agent and complete synchronous and streaming messages, task lookup, and task cancellation.
- The existing `call_a2a_agent` tool can discover and call an Agent implemented with Python `a2a-sdk==0.3.2`.
- Existing A2A v1.0 callers and callees continue to use v1.0 without being downgraded.
- Another machine on the intranet can call the A2A endpoints by using a directly reachable URL.
- A container image remains portable across hosts, container addresses, Services, and ingress deployments because its advertised URL is runtime configuration.

<a id="constraints"></a>
## Constraints

- The implementation remains under `business-agent/` and does not modify `packages/` or `apps/`.
- The existing DSH Web listener remains loopback-only. LAN exposure must not publish the Web UI, management APIs, or other Host routes.
- The compatibility target is Python package version `0.3.2`, whose wire protocol belongs to the A2A v0.3 family. The Agent Card advertises the compatibility interface as protocol version `0.3`; it does not advertise the package patch version as a wire protocol version.
- The research deployment prioritizes direct connectivity. Bearer authentication remains available but is optional for the dedicated LAN listener and is not an acceptance requirement.
- JSON-RPC remains the only protocol binding. REST, gRPC, push notifications, task listing, and stream resubscription remain outside scope.

<a id="selected-approach"></a>
## Selected approach

The A2A bridge enables the official `@a2a-js/sdk` v0.3 compatibility layer on its Agent Card handler, JSON-RPC handler, Agent Card resolver, and JSON-RPC transport factory. The Agent Card declares separate JSON-RPC interfaces for v1.0 and v0.3 at the same endpoint. The SDK translates v0.3 wire requests, responses, stream events, errors, and cards at the transport layer; the bridge executor, task store, Session mapping, and model-visible tool continue to use the v1.0 internal types.

The plugin also gains an optional dedicated HTTP listener. The listener hosts the same private Express application that serves `/.well-known/agent-card.json` and the configured JSON-RPC route, but it does not register any DSH Web routes. Omitting the listener configuration preserves the existing shared-loopback behavior for local development and compatible deployments.

Binding the shared DSH Web listener to `0.0.0.0` was rejected because it exposes unrelated Host capabilities. Requiring an external reverse proxy was rejected as the only supported path because it prevents the requested direct startup flow, although a deployment may still place a proxy or ingress in front of the dedicated listener.

<a id="protocol-compatibility"></a>
## Protocol compatibility

### Agent Card discovery

Both protocol generations use `/.well-known/agent-card.json` for the compatibility target. The Agent Card handler enables `legacyCompat` and varies the response by the `A2A-Version` request header. A v1.0 request receives the v1.0 card. A missing header or a v0.3 request receives the SDK's v0.3-compatible card fields, including the JSON-RPC URL and transport declaration.

The canonical v1.0 Agent Card contains two `supportedInterfaces` entries for the same JSON-RPC URL: one with `protocolVersion: '1.0'` and one with `protocolVersion: '0.3'`. The implementation uses the SDK compatibility helper to avoid divergent hand-written interface duplication.

### Inbound JSON-RPC

The JSON-RPC handler enables `legacyCompat`. It accepts v1.0 method names and the v0.3 methods required by the current bridge: `message/send`, `message/stream`, `tasks/get`, and `tasks/cancel`. The SDK converts v0.3 request fields to the bridge's v1.0 request types before dispatch and converts results, streaming events, and failures back to v0.3 fields before writing the response.

The bridge keeps its current public-operation allowlist. Compatibility does not make unsupported v0.3 methods available.

### Outbound calls

The outbound client enables `legacyCompat` on both `DefaultAgentCardResolver` and `JsonRpcTransportFactory`. A v0.3 card is normalized into the v1.0 internal Agent Card type with a v0.3 interface marker. The transport factory selects the legacy JSON-RPC transport only for that interface. A v1.0 card continues to select the native v1.0 transport.

The `call_a2a_agent` input and result fields do not change. The tool still accepts an explicit Agent Card URL, and protocol selection remains transport-owned rather than model-selected.

<a id="dedicated-listener"></a>
## Dedicated listener

The server module separates the A2A Express application from its hosting adapter. One adapter registers the application on `ctx.webServer` for the existing shared mode. A second adapter owns a Node HTTP server for dedicated mode and binds only the configured host and port.

The dedicated listener exposes exactly two routes:

- `GET /.well-known/agent-card.json`
- `POST <route>`, which defaults to `/a2a`

All other paths return HTTP 404. The dedicated server does not serve the DSH Web application and cannot dispatch into unrelated `ctx.webServer` registrations.

`listener.host` controls the bind address. `0.0.0.0` accepts connections through any container or host interface; it is never advertised in the Agent Card. `publicBaseUrl` controls the address returned to peers and must identify the address that those peers can resolve and reach.

For a container deployment, `publicBaseUrl` comes from a runtime environment variable and normally names a Docker Compose service, Kubernetes Service, ingress hostname, load balancer, or stable host address. The container's transient IP is not configuration authority.

<a id="configuration"></a>
## Configuration

```yaml
- id: business-a2a-bridge
  name: '@deepseek-ai/dsh-business-a2a-bridge'
  config:
    route: /a2a
    listener:
      host: 0.0.0.0
      port: 3082
    publicBaseUrl: !!js process.env.A2A_PUBLIC_BASE_URL
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

`listener` is optional. When omitted, the plugin uses the existing shared Web listener and preserves current configuration behavior. When present, `host` accepts `127.0.0.1` or `0.0.0.0`, and `port` accepts an available TCP port from 1 through 65535.

`publicBaseUrl` remains the single advertised-address field for shared and dedicated modes. A loopback listener may derive it from the listener port when the field is omitted. A listener bound to `0.0.0.0` requires an explicit absolute HTTP(S) value and rejects `0.0.0.0` as the advertised hostname. Cordis configuration may read the value from `A2A_PUBLIC_BASE_URL`, so the same image can advertise different addresses in different deployments.

For the research deployment, `bearerTokenEnv` is optional in both modes. If configured, its current validation, Agent Card declaration, and request enforcement remain unchanged.

The startup helper gains A2A-specific parameters for the dedicated port and advertised base URL and exports their environment values to the child process. Its normal Web URL remains `http://127.0.0.1:3081`; startup output prints the separate A2A Agent Card URL when dedicated mode is active.

<a id="lifecycle-and-failures"></a>
## Lifecycle and failures

The plugin starts persistence and execution services before publishing the dedicated listener. A bind failure rejects plugin startup with the requested host and port in the diagnostic. The listener starts accepting traffic only after its route application and request handler are complete.

Shutdown first stops accepting new HTTP connections, then waits for admitted HTTP responses to close before completing server disposal. Scheduler, Session tracking, and storage cleanup retain their existing quiescent ordering. Repeated cleanup is idempotent, and partial startup closes every resource created before the failure.

Invalid protocol requests keep the SDK's version-appropriate A2A error response. Invalid listener configuration fails at plugin load. A missing `A2A_PUBLIC_BASE_URL` fails at plugin load when the dedicated listener binds all interfaces, because the service cannot publish a reachable Agent Card URL safely by guessing a container or host address.

<a id="testing"></a>
## Testing

Focused unit tests cover interface duplication, version-negotiated Agent Cards, v0.3 and v1.0 JSON-RPC dispatch, outbound transport selection, listener configuration, advertised URL validation, bind failures, and idempotent shutdown.

Protocol integration tests send Python 0.3.2-compatible JSON fixtures through synchronous, streaming, lookup, and cancellation paths. Existing v1.0 tests remain and verify that v1.0 clients do not use the legacy transport.

An interoperability smoke fixture uses the actual `a2a-sdk==0.3.2` package in an isolated Python environment. One direction starts the Business Agent server and drives it with the Python client. The other starts a minimal Python 0.3.2 Agent and invokes it through `call_a2a_agent`. The smoke verifies the Agent Card, method names, request and response fields, streaming events, and terminal output rather than only checking HTTP status.

Network tests bind `127.0.0.1:0` inside the test adapter, read the assigned address after the listening event, and never depend on a fixed development port. A LAN acceptance smoke binds `0.0.0.0` and calls the service through a reachable interface address when the environment provides one; CI may use the container or loopback route while preserving the same dedicated-listener code path.

The implementation updates the package README pair, Business Agent startup documentation, bundle configuration, recorded model-visible snapshot when required, and one Agent Note for the protocol and listener decisions.

<a id="acceptance-criteria"></a>
## Acceptance criteria

- A Python client using `a2a-sdk==0.3.2` discovers the Business Agent and completes synchronous and streaming messages.
- The Python client reads completed Tasks and cancels queued or active Tasks through v0.3 JSON-RPC methods.
- `call_a2a_agent` discovers and calls a Python `a2a-sdk==0.3.2` Agent without a model-visible protocol switch.
- Existing v1.0 inbound and outbound integration tests continue to pass and select v1.0 transports.
- Another intranet machine can reach the dedicated Agent Card and JSON-RPC URLs while the DSH Web listener remains loopback-only.
- The same build runs with different advertised addresses by changing `A2A_PUBLIC_BASE_URL` without editing repository files or rebuilding the image.
- Stopping or reloading the plugin closes the dedicated listener and waits for admitted responses without leaving a listening process behind.

<a id="references"></a>
## References

- [A2A Python SDK 0.3.2 changelog](https://github.com/a2aproject/a2a-python/blob/v0.3.2/CHANGELOG.md)
- [A2A Python SDK 0.3.2 types](https://github.com/a2aproject/a2a-python/blob/v0.3.2/src/a2a/types.py)
- [A2A JavaScript SDK v0.3 compatibility guide](https://github.com/a2aproject/a2a-js/blob/main/docs/compatibility-v0_3.md)
- [A2A JavaScript SDK compatibility implementation notes](https://github.com/a2aproject/a2a-js/blob/main/src/compat/v0_3/README.md)

<a id="non-goals"></a>
## Non-goals

This change does not expose the shared DSH Web listener to the network, select a container's public address automatically, add TLS termination, require authentication for the research environment, add a remote-agent registry, or add REST and gRPC protocol bindings. Production authentication, authorization, trusted-proxy handling, rate limits, and public-Internet hardening require a separate deployment-security design.
