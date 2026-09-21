---
description: "Configuration and Agent Card contracts for exposing a Business Agent through A2A Protocol v1.0 and calling another A2A agent by URL."
kind: "package-reference"
---

# Business A2A bridge

English | [中文](README.zh.md)

## Summary

This package validates the network identity and capability description for a Business Agent that uses A2A Protocol v1.0. It produces one JSON-RPC Agent Card, defaults local development to loopback, and requires an explicit public URL plus Bearer token when the Host listens on every interface. It rejects public URLs and routes that could embed credentials or ambiguous request targets.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The package currently exposes `resolveConfig` and `buildAgentCard` for the bridge composition. The Business Agent bundle will own the Cordis mount after the server, Session execution, and outbound tool are connected.

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

Verify the implemented configuration and Agent Card contract with `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Configuration resolution validates the deployment before any listener is mounted. The Card builder derives its single A2A JSON-RPC interface from the normalized public URL and route, advertises streaming without push notifications, and describes Bearer authentication without copying the secret into discovery output. The environment token is read once into the resolved runtime configuration.

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

None, as the current package only resolves transport metadata and registers no model-facing contribution.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The current package exports configuration and Agent Card construction; protocol routes, Session-backed execution, persistence, and the outbound tool are not connected yet.
- Discovery supports one Agent Card and one JSON-RPC interface per process.
- Outbound authentication, push notifications, files, media, gRPC, and HTTP+JSON are outside the approved scope.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
