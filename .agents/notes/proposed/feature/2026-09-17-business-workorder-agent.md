# Agent Note: Business Workorder Agent

Status: proposed

English | [中文](2026-09-17-business-workorder-agent.zh.md)

## Problem

Business workflows need a durable execution authority, a read-only operational view, and an agent that asks for human decisions only when execution blocks. Putting all three concerns in the conversation runtime would couple business state to one agent host, make ordinary progress consume model context, and create a second business-state authority inside DeepSeek Harness.

## Proposal

Keep the workorder service independent from DSH. The service owns order state, state transitions, decision records, HTTP snapshots, SSE notifications, and MCP write tools. A DSH Host plugin owns session-to-order bindings, event cursors, wake budgets, and message delivery. A DSH Client plugin registers a read-only right-Sidebar tab, gets only the selected `orderId` from the Host, and reads business snapshots and SSE directly from the service.

The left conversation remains the existing DSH interface. The agent changes business state only through native MCP tools. Ordinary progress never enters model context. A service event can wake the agent only when it carries `needsHuman: true`; an idle agent receives `followup()`, while a running agent receives `inject()` for its next step.

One order has one primary session, and one session can bind multiple orders. The right Sidebar follows the session's most recently active order for the MVP. Orders start in `ready`; `start_order` performs `ready -> running`. A manual activity requires separate `start_activity` and `finish_activity` calls. Deliverables use opaque `resourceId` values. The wake budget is three consecutive active wakes per session and order, reset only by human input.

Implementation stays under `business-agent/` as Cordis plugins, a bundle, and a profile patch. It does not modify `packages/`, `apps/`, or the agent loop. The MVP first proves one deterministic order from user request through native MCP, asynchronous execution, SSE refresh, human wake, manual completion, and final right-Sidebar state. Persistence, recovery, security, deliverable reads, and multi-order navigation follow as separate increments.

## Alternatives considered

**Store session bindings in the business service.** Rejected because the business service would need agent-host identities and would duplicate Host-owned routing state.

**Write progress into the conversation.** Rejected because routine execution would consume model context and stale progress could be mistaken for current authority. The agent queries the current order only when it must decide.

**Add write controls to the right Sidebar.** Rejected because a second write path would split authorization and audit behavior between the UI and MCP tools.

**Modify the DSH agent loop.** Rejected because Cordis events, native MCP tools, right-Sidebar slots, and Agent message APIs already provide the required extension points.

## Acceptance criteria

- The workorder service builds and runs without DSH.
- A business profile loads Host and Client plugins without modifying `packages/` or `apps/`.
- Native MCP calls expose `orderId` in top-level `tool/call` events.
- Only a new blocking event can wake or inject the bound agent, and replay does not duplicate delivery.
- The right Sidebar is read-only and refreshes authoritative snapshots after SSE notifications.
- A deterministic keyless scenario completes one order across the real DSH page, MCP service, wake adapter, and right Sidebar.

## Risks

The MVP keeps service and Host state in memory, so a process restart loses progress or routing until the persistence increment ships. Browser-direct reads also require a development CORS allowance before deployment authentication and origin restrictions are complete. Native-tool-only binding excludes PTC-only presentation until an explicit binding mechanism exists.
