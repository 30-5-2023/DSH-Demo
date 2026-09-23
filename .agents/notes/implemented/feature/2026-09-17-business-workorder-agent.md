# Agent Note: Business Workorder Agent

Status: implemented

English | [中文](2026-09-17-business-workorder-agent.zh.md)

## Problem

Business workflows need a durable execution authority, a read-only operational view, and an agent that asks for human decisions only when execution blocks. Putting all three concerns in the conversation runtime would couple business state to one agent host, make ordinary progress consume model context, and create a second business-state authority inside DeepSeek Harness.

## Decision

The workorder service stays independent from DSH. The service owns order state, state transitions, HTTP snapshots, SSE notifications, and MCP tools. A DSH Host plugin owns in-memory session-to-order bindings, event cursors, wake budgets, and message delivery. The business UI plugin registers a read-only right-Sidebar tab, receives validated `serviceUrl` and one MVP `orderId` through Host page injection, and reads business snapshots and SSE directly from the service. The business Bundle disables the generic workspace-file and terminal tab types, which leaves the work-order entry as the default page when the right Sidebar opens. A separate development plugin registers a collapsed floating card for mock-only controls; its reset action calls an opt-in `/debug` endpoint and never enters the production MCP tool set. The same plugin records bounded, process-local wake observations from the Host and exposes the service event, routing decision, and exact delivered Agent message through a same-origin debug stream.

The left conversation remains the existing DSH interface. The agent changes business state only through native MCP tools. Ordinary progress never enters model context. A service event can wake the agent only when it carries `needsHuman: true`; an idle agent receives `followup()`, while a running agent receives `inject()` for its next step.

One order has one primary session, and one session can bind multiple orders. The MVP right Sidebar displays one Profile-configured order; session-aware selection remains a later increment. Orders start in `ready`; `start_order` performs `ready -> running`. The seeded pipeline runs two automatic activities, waits at activity 3 for separate `start_activity` and `finish_activity` calls, then runs two more automatic activities before completing. Deliverables use opaque `resourceId` values. The wake budget is three consecutive active wakes per session and order, reset only by human input.

Implementation stays under `business-agent/` as Cordis plugins, a Bundle, and a Profile patch. It does not modify `packages/`, `apps/`, or the agent loop. A deterministic keyless scenario completes the five-activity order through replayed model output, the official MCP Client, sequential asynchronous execution, SSE refresh, one human wake at activity 3, resumed automatic execution, and the final right-Sidebar state. Persistence, recovery, security, deliverable reads, and session-aware multi-order navigation remain separate increments.

## Alternatives considered

**Store session bindings in the business service.** Rejected because the business service would need agent-host identities and would duplicate Host-owned routing state.

**Write progress into the conversation.** Rejected because routine execution would consume model context and stale progress could be mistaken for current authority. The agent queries the current order only when it must decide.

**Add write controls to the right Sidebar.** Rejected because a second write path would split authorization and audit behavior between the UI and MCP tools.

**Modify the DSH agent loop.** Rejected because Cordis events, native MCP tools, right-Sidebar slots, and Agent message APIs already provide the required extension points.

## Verification

- The service package verifies HTTP, SSE, MCP, asynchronous execution, invalid transitions, deterministic time, and CORS behavior without DSH.
- Host tests verify native-tool binding, idle and running delivery, replay deduplication, wake budgets, untrusted text, reconnection, and teardown.
- Client artifact tests verify the Host-injected configuration and the built browser closure.
- The debug plugin artifact and browser scenario verify opt-in reset, confirmation, SSE refresh, no reset wake, progress filtering, and the exact `inject()` delivery record; Host unit coverage verifies `followup()` observations for idle Agents.
- A keyless Session snapshot and built-Web scenario complete one order across the real DSH page, official MCP Client, service, wake adapter, and directly opened right-Sidebar work-order page.

## Consequences

The service and Host keep state in memory, so a process restart loses progress or routing until the persistence increment ships. Browser-direct reads require a development CORS allowance before deployment authentication and origin restrictions are complete. The right Sidebar displays the Host-configured MVP order rather than deriving the current Session binding. Native-tool-only binding excludes PTC-only presentation until an explicit binding mechanism exists. The keyless scenario verifies deterministic replay, not a live model provider.
