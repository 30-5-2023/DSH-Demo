# Business work-order service

English | [中文](README.zh.md)

`@deepseek-ai/dsh-business-workorder-service` is the MVP mock for the external business system. It has no DSH dependency and can run and be tested independently.

## Run and verify

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-service build
pnpm --filter @deepseek-ai/dsh-business-workorder-service test
pnpm --filter @deepseek-ai/dsh-business-workorder-service start
```

The default listener is `127.0.0.1:8090`. Use `--port 0` in owned test processes to request a random available port.

Browser reads default to the local Web origins `http://127.0.0.1:3081` and `http://localhost:3081`. `createService({ corsOrigins })` can select other development origins; production authentication and origin policy remain deferred.

## MVP behavior

The service seeds one `ready` order with five sequential activities. Activity 1 runs automatically. Activities 2 through 5 each create a service-owned `interaction-request`, enter `waiting`, and resume only after `submit_interaction_response` accepts validated values. The four requests cover Agent input, manual evidence, quality confirmation, and tool-error clarification. A resumed activity runs through the simulated executor; the order becomes `done` after activity 5 finishes.

The simulated executor takes 800 ms per automatic activity by default. This delay keeps automatic state transitions observable in the right Sidebar; `createService({ stepMs })` can select another development duration.

The package `start` script enables mock debugging. Direct launches must pass `--debug`; programmatic callers use `createService({ debug: true })`. Debug mode exposes `POST /debug/orders/:orderId/reset`, which replaces the configured seed order, preserves monotonic service revisions, and publishes a non-blocking `order.reset` refresh signal. The endpoint is absent when debug mode is disabled and is not part of the production business API.

State is process-local in the MVP. Restarting the service restores the seed state. Persistence and restart recovery belong to Task 7.

## Public interfaces

See [Business Agent integration interfaces](../INTEGRATION_CONTRACTS.md) for cross-module fields, ordering, recovery semantics, and replacement requirements. This section lists only the endpoints that this service currently exposes.

| Interface | Endpoint or tool | Purpose |
|---|---|---|
| HTTP | `GET /health` | Process health and current revision |
| HTTP | `GET /orders/:orderId` | Authoritative order snapshot |
| SSE | `GET /events?orderId=...` | Monotonic activity events used as refresh and wake signals |
| MCP | `POST /mcp` | Streamable HTTP MCP endpoint |
| MCP | `get_order` | Read an order snapshot |
| MCP | `start_order` | Accept asynchronous order execution |
| MCP | `get_interaction_request` | Read a pending structured interaction |
| MCP | `submit_interaction_response` | Validate values and resume its activity |
| MCP | `start_activity` | Start the waiting manual activity |
| MCP | `finish_activity` | Finish the running manual activity |

MCP responses do not include server `instructions`. Every tool uses the field name `orderId`, which lets the Host plugin associate a successful top-level tool call with its DSH session.

## Event rules

Every state change increments the service-wide `rev` and emits one host-neutral event. `activity.changed` refreshes the board; `interaction.required` carries the identifiers needed for the wake router to ask the Agent to read the full request through MCP. Events never contain DSH session or message instructions. Consumers use `orderId + rev` for deduplication and reload the HTTP snapshot when they observe a revision gap.

## MVP limitations

- In-memory state only; one seeded order.
- Local-development CORS only; no authentication or production origin policy.
- No retry, skip, rebind, failure simulation, or deliverable download.
- No session binding. DSH session/order binding belongs to the Host plugin.
- Resource fields accept an existing `resourceId`; upload and resource authorization are not implemented by this mock.
