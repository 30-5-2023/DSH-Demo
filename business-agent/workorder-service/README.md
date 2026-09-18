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

The service seeds one `ready` order with five sequential activities: fetch customer master data, generate a credit analysis, review the financial reporting basis, run a compliance check, and archive the review package. `start_order` accepts only `ready -> running` and returns before the first automatic activity completes. The engine runs the first two activities in order, then leaves activity 3 in `waiting` with `needsHuman: true` until a user handles it through the agent. `start_activity` and `finish_activity` are separate operations. Finishing activity 3 starts activities 4 and 5 automatically; the order becomes `done` only after both finish.

The simulated executor takes 800 ms per automatic activity by default. This delay keeps automatic state transitions observable in the right Sidebar; `createService({ stepMs })` can select another development duration.

The package `start` script enables mock debugging. Direct launches must pass `--debug`; programmatic callers use `createService({ debug: true })`. Debug mode exposes `POST /debug/orders/:orderId/reset`, which replaces the configured seed order, preserves monotonic service revisions, and publishes a non-blocking `order.reset` refresh signal. The endpoint is absent when debug mode is disabled and is not part of the production business API.

State is process-local in the MVP. Restarting the service restores the seed state. Persistence and restart recovery belong to Task 7.

## Public interfaces

| Interface | Endpoint or tool | Purpose |
|---|---|---|
| HTTP | `GET /health` | Process health and current revision |
| HTTP | `GET /orders/:orderId` | Authoritative order snapshot |
| SSE | `GET /events?orderId=...` | Monotonic activity events used as refresh and wake signals |
| MCP | `POST /mcp` | Streamable HTTP MCP endpoint |
| MCP | `get_order` | Read an order snapshot |
| MCP | `start_order` | Accept asynchronous order execution |
| MCP | `start_activity` | Start the waiting manual activity |
| MCP | `finish_activity` | Finish the running manual activity |

MCP responses do not include server `instructions`. Every tool uses the field name `orderId`, which lets the Host plugin associate a successful top-level tool call with its DSH session.

## Event rules

Every state change increments the service-wide `rev` and emits one host-neutral event. The event describes the order and activity, includes `needsHuman`, and never contains DSH session or message instructions. Consumers use `orderId + rev` for deduplication and reload the HTTP snapshot when they observe a revision gap.

## MVP limitations

- In-memory state only; one seeded order.
- Local-development CORS only; no authentication or production origin policy.
- No retry, skip, rebind, failure simulation, or deliverable download.
- No session binding. DSH session/order binding belongs to the Host plugin.
