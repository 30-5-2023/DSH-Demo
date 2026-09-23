# Agent Note: Service-owned work-order interaction forms

Status: implemented

English | [中文](2026-09-22-business-agent-dynamic-forms.zh.md)

## Problem

Any work-order activity can require typed user input or clarification. A model response is probabilistic and cannot be the source of a stable UI protocol. The existing business integration had only text wake notices and no replayable route from a service-owned input request to a left-side form and back to an authoritative activity transition.

## Decision

The work-order service owns a versioned `interaction-request` independent of activity type and publishes `interaction.required` with only routing identifiers. The wake adapter asks the bound DSH Agent to call `mcp__workorder__get_interaction_request`. An Agent-scoped presentation projector persists the MCP `structuredContent` as `tool/result.meta`, and the business Client toolview validates that metadata before rendering a fixed field vocabulary.

The Client never calls the work-order write API. It records the submitted values as a Session UserMessage that asks the Agent to call `mcp__workorder__submit_interaction_response`. The service validates the values, revision, ownership, and idempotency key before changing the activity from `waiting` to `running`.

The MVP vocabulary is `text`, `textarea`, `integer`, `date`, `boolean`, `select`, `multi-select`, and `resource`. A resource value contains a platform `resourceId`; file upload is a separate operation. Arbitrary HTML, scripts, remote components, and model prose are not form definitions.

## Alternatives considered

**Reuse `dsh-user-questions`.** Rejected because its question vocabulary does not express business field validation or resource references.

**Parse model prose.** Rejected because wording changes would alter UI behavior and Session replay would not carry a validated form definition.

**Let the browser write the work order.** Rejected because that bypasses model-visible Session input, MCP authorization, idempotency, and audit.

**Make A2A the form protocol.** Rejected because manual, quality, and tool activities require the same interaction. A2A executors may map their own input-required state into the service-owned request, but do not own the UI protocol.

## Consequences

The work-order service, Host adapter, and Client each validate their wire input. `activity.changed` remains a board refresh signal, while `interaction.required` is the single form wake signal. The current mock stores interactions and idempotency results in memory and accepts an existing resource id; production deployment still requires durable interaction records, event replay, resource authorization, and audit retention.
