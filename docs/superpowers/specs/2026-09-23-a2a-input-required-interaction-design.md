# A2A v0.3 Input-Required Interaction Design

English | [中文](2026-09-23-a2a-input-required-interaction-design.zh.md)

Design status: approved for implementation planning on 2026-09-23.

## Summary

The Business Agent can pause an inbound A2A v0.3 Task when its DSH Session calls `ask_user_question`, expose the questions and choices through `input-required`, and resume the same model turn after the caller answers on the same Task. The status Message combines a human-readable TextPart with a versioned DataPart, so generic A2A clients can answer in natural language while DSH-aware clients retain structured choices. `tasks/get`, blocking requests, and streaming requests expose the same durable Task state. A process restart cannot reconstruct an in-memory tool call, so a waiting Task fails explicitly instead of pretending that it can resume.

This design extends the existing [A2A Bridge design](2026-09-20-a2a-bridge-design.md), [A2A v0.3 compatibility and LAN listener design](2026-09-21-a2a-v03-lan-compatibility-design.md), and [A2A v0.3 file Artifact design](2026-09-22-a2a-v03-file-artifacts-design.md). It supersedes those documents only where interrupted Tasks, question Messages, continuation input, and outbound interaction results differ.

## Table of Contents

- [Goals](#goals)
- [Constraints](#constraints)
- [Selected approach](#selected-approach)
- [Runtime flow](#runtime-flow)
- [Question Message](#question-message)
- [Answer Message](#answer-message)
- [Continuation and task history](#continuation-and-task-history)
- [Task queries and streaming](#task-queries-and-streaming)
- [Outbound calls](#outbound-calls)
- [Persistence and recovery](#persistence-and-recovery)
- [Cancellation, timeout, and concurrency](#cancellation-timeout-and-concurrency)
- [Failures](#failures)
- [A2A v0.3 compatibility](#a2a-v03-compatibility)
- [Testing](#testing)
- [Acceptance criteria](#acceptance-criteria)
- [Non-goals](#non-goals)
- [References](#references)

<a id="goals"></a>
## Goals

- An inbound A2A Task enters `input-required` when its exact live DSH Agent calls `ask_user_question`.
- The Task status contains readable questions and versioned structured choices without defining a private transport or replacing A2A Parts.
- A caller can answer through a new `message/send` request on the same Task and resume the original tool call and model turn.
- A caller can retrieve the complete current question through `tasks/get` after the request that produced it has returned.
- `call_a2a_agent` can return a remote interaction to the calling model and can send a follow-up answer with the returned Task id.
- Blocking, streaming, polling, cancellation, timeout, duplicate delivery, and process restart have deterministic behavior.
- Exact Python `a2a-sdk==0.3.2` interoperability covers questions, polling, answers, and final output in both directions.

<a id="constraints"></a>
## Constraints

- The implementation remains under `business-agent/` and consumes the existing user-questions capability without modifying `packages/` or `apps/`.
- The acceptance target is the A2A v0.3 JSON-RPC wire format used by Python `a2a-sdk==0.3.2`.
- A2A standardizes `input-required`, Task status Messages, and DataPart containers, but it does not standardize a choice-form JSON schema.
- A generic A2A peer that ignores the structured DataPart must still be able to understand and answer the TextPart.
- The bridge preserves the SDK's current v1.0 behavior as regression coverage, but this change does not add a v1.0 interaction acceptance target.
- Authentication, authorization, and public-Internet deployment remain outside this research change.
- A suspended DSH tool call exists only in the running process and cannot be reconstructed after restart.

<a id="selected-approach"></a>
## Selected approach

The bridge keeps the original Session turn alive while `ask_user_question` awaits an answer. An A2A interaction broker associates the exact live Agent id, which is the Session id, with the active A2A Task. When that Agent asks a question, the broker persists and publishes an `input-required` Task status before it waits for a continuation Message.

The official A2A SDK returns the blocking or streaming request after it observes `input-required`, while the Task event bus and original executor invocation remain alive. A later `message/send` request with the same Task id reaches the same event bus. The executor validates the answer, persists and publishes `working`, resolves the waiting user-question request, and waits for the original turn to complete.

This design preserves a real tool continuation. Starting a new model turn after an answer was rejected because it would turn the answer into a new prompt and leave the original tool call unresolved. Durable reconstruction of an arbitrary suspended model tool call was rejected because the current Session runtime does not expose a resumable execution checkpoint and the business fork may not change the Agent Loop.

The interaction schema is an optional application-level convention inside a standard DataPart. The accompanying TextPart carries the complete question, and no required A2A extension is advertised. Peers that understand the schema can render choices; other peers can reply with ordinary text.

<a id="runtime-flow"></a>
## Runtime flow

1. `message/send` creates or resumes a Task, persists `submitted`, creates or resolves the context-owned Session, and persists `working`.
2. The Session model calls `ask_user_question` during that Task's model turn.
3. The A2A interaction broker accepts the request only when `request.agent.id` matches an active inbound A2A execution. It calls the waterfall's `next()` for every other Agent or unscoped request.
4. The broker creates one pending interaction, appends the Agent question Message to Task history, persists `input-required`, and publishes the status update.
5. The current blocking response or event stream returns the interrupted Task. The original Session turn remains suspended inside the user-question tool.
6. The caller sends an answer with the same `taskId`; `contextId` may be included and must match when present.
7. The executor identifies the active pending interaction before normal new-Task admission, validates the answer, persists and publishes `working`, and resolves the pending user-question result.
8. The original Session turn continues, produces its normal text, data, and file Artifacts, and settles the Task as `completed` or another terminal state.
9. The follow-up request remains attached to the Task event bus until it receives the resumed Task's result.

The context scheduler continues to serialize the Session. A waiting interaction retains the context lock and one `maxConcurrentContexts` slot in this research delivery, so a second Task cannot start a concurrent turn in the same Session.

<a id="question-message"></a>
## Question Message

The `input-required` status contains an Agent Message with the Task id, context id, a unique message id, a TextPart, and a DataPart. The bridge stores that same Message in Task history before it publishes the status.

The TextPart renders every question id, question, optional detail, and option label with its description. It does not require Markdown-aware rendering and contains enough information for a text-only peer to answer.

The DataPart uses this payload:

```json
{
  "schema": "urn:deepseek-harness:a2a:input-required:v1",
  "questions": [
    {
      "id": "environment",
      "question": "Select the target environment",
      "header": "Environment",
      "detail": "The deployment uses the selected environment immediately.",
      "options": [
        { "label": "Development", "description": "Deploy to the development environment." },
        { "label": "Test", "description": "Deploy to the test environment." }
      ],
      "multiSelect": false
    }
  ]
}
```

The bridge preserves the `id`, `question`, optional `header`, optional `detail`, optional `options`, optional `multiSelect`, and optional presentation `intent` supplied by the user-questions request. The schema version changes only when a consumer-visible field meaning or validation rule changes.

After an invalid answer, the same DataPart also includes an `error` object with stable code `A2A_INTERACTION_INVALID_RESPONSE` and a safe message. The original questions remain present so the caller can correct the response without another Task query.

<a id="answer-message"></a>
## Answer Message

A structured caller sends a user Message whose DataPart uses this payload:

```json
{
  "schema": "urn:deepseek-harness:a2a:input-response:v1",
  "answers": [
    {
      "id": "environment",
      "selected": ["Test"]
    }
  ]
}
```

Question ids must be unique and must match the pending interaction. A structured response covers every pending question exactly once. Each selected label must be one of that question's options, and a question without `multiSelect: true` accepts at most one selected label. A question without options uses a non-empty `custom` value; an option question may also carry `custom` text when the caller supplies a free-form alternative.

If no recognized response DataPart exists, the bridge accepts the non-empty joined TextPart content as a compatibility answer. For one pending question, it becomes that question's `custom` value. For multiple questions, it becomes the first question's `custom` value so the resumed model can interpret the combined response and ask again when information remains missing.

When a recognized response DataPart is present, it is authoritative. Invalid structured data does not silently fall back to adjacent text because that would hide an integration error.

FileParts do not answer an `ask_user_question` request. The bridge may materialize files in ordinary A2A input and output paths, but a continuation with neither a recognized response DataPart nor non-empty text remains `input-required`.

<a id="continuation-and-task-history"></a>
## Continuation and task history

The caller continues an interrupted Task with `message/send` and the existing `taskId`. The caller may omit `contextId`; the server infers it from the Task. If both values are present, the existing SDK rejects a context mismatch.

The request handler appends the caller's answer Message to Task history before the executor handles it. The question Message was appended when the Task entered `input-required`, so a completed Task history records the initial request, Agent question, caller answer, and any later turns allowed by the history limit.

The first valid answer atomically claims the pending interaction. A retry with the same message id does not resolve the tool call twice. A concurrent continuation after an answer has been accepted observes the current `working` or terminal Task and attaches to its result without injecting another answer.

An invalid answer produces another `input-required` status Message with a new message id, the validation error, and the same questions. The original pending tool call remains unresolved.

<a id="task-queries-and-streaming"></a>
## Task queries and streaming

JSON-RPC clients query the current state with `tasks/get`; A2A v0.3 does not define `message/get`. The REST equivalent is `GET /v1/tasks/{id}` when the transport is enabled.

The repository persists the complete Task before publishing each state change. A query during an interaction therefore returns `status.state: "input-required"` and the complete `status.message` with its TextPart, DataPart, Task id, context id, and message id. A history limit affects Task history only and does not remove the current status Message.

`message/stream` emits the same persisted status update and closes that response stream at `input-required`. A caller can later continue through `message/send` or subscribe again through the supported Task subscription operation.

Blocking, streaming, and polling clients observe equivalent Task semantics. None of these paths converts the question into an Artifact because a clarification is communication required to continue, not a Task result.

<a id="outbound-calls"></a>
## Outbound calls

`call_a2a_agent` adds an optional `task_id` input. The tool sets the outgoing Message Task id when present and keeps `context_id` optional, matching the A2A continuation rule. A JSON `message` becomes a DataPart and a string `message` becomes a TextPart, so the calling model can send either the versioned structured answer or a natural-language answer.

The result adds an optional `interaction` object when the remote Task returns `input-required`:

```json
{
  "context_id": "context-1",
  "task_id": "task-1",
  "state": "input-required",
  "interaction": {
    "text": "Select the target environment: Development or Test.",
    "data": [
      {
        "schema": "urn:deepseek-harness:a2a:input-required:v1",
        "questions": []
      }
    ]
  }
}
```

`interaction.text` joins remote TextParts in order. `interaction.data` preserves remote DataPart values in order. FileParts in a status Message use the existing bounded materialization path and appear in the result's `files` array.

Streaming collection stops at `input-required` as well as terminal states. Synchronous Task parsing and streaming aggregation both read `status.message`; neither waits for `completed` after the peer requests input.

Final Task Artifacts continue to use `output` and `files`. The separate `interaction` field prevents a question from being mistaken for completed output.

<a id="persistence-and-recovery"></a>
## Persistence and recovery

The Task repository stores the complete `input-required` Task, including the current status Message and history. `tasks/get` therefore works after the original HTTP response and while the process remains alive.

The pending user-question resolver, live Agent, Session turn, and event bus remain process-owned. Startup recovery extends the existing interrupted-Task scan to include `input-required`; it changes such a Task to `failed` with `A2A_HOST_INTERRUPTED` because no live tool call exists to receive a later answer.

Recovery preserves terminal Tasks and their Artifacts. It does not advertise a stale question after restart or accept an answer that cannot reach the original model turn.

<a id="cancellation-timeout-and-concurrency"></a>
## Cancellation, timeout, and concurrency

`tasks/cancel` aborts the pending user-question wait, cancels the Session turn once, and persists `canceled`. The broker removes its Session and Task association only after the execution settles, so cancellation and answer races have one terminal winner.

The existing `requestTimeoutMs` bounds the complete inbound Session turn, including time spent in `input-required`. Timeout cancels the Session and persists `failed` with `A2A_EXECUTION_TIMEOUT`. Deployments that require a longer human response window set the existing validated configuration field to a larger value within its current limit.

One Task has at most one pending interaction. The broker rejects a second simultaneous question from the same execution as a turn failure because one continuation Message could not identify which suspended tool call it answers.

The waiting execution retains one context scheduler slot. Releasing global capacity while preserving an exclusive Session lock requires a scheduler suspension design and is deferred until measured waiting volume justifies it.

<a id="failures"></a>
## Failures

Invalid structured answers are recoverable interaction errors. The Task stays `input-required`, the status Message contains `A2A_INTERACTION_INVALID_RESPONSE`, and the caller can answer again.

An unknown Task id uses the SDK's `TaskNotFoundError`. A context mismatch uses the SDK's malformed-request error. A continuation sent to a terminal Task uses the SDK's `UnsupportedOperationError`.

A continuation for a persisted `input-required` Task without a live broker record fails safely. Normal startup converts that state to `failed`; a narrow startup race also refuses the answer rather than starting a replacement model turn.

Internal exceptions, remote response bodies, Session details, and stack traces do not enter model-visible or A2A-visible diagnostics. Existing safe failure conversion remains authoritative for terminal errors.

<a id="a2a-v03-compatibility"></a>
## A2A v0.3 compatibility

The bridge continues to implement its executor with the official `@a2a-js/sdk` internal types and enables the SDK's v0.3 compatibility adapter. The adapter emits v0.3 JSON-RPC method names, lower-case Task states such as `input-required`, and `kind`-discriminated TextPart, DataPart, and FilePart values.

Python `a2a-sdk==0.3.2` parses the status Message and DataPart through its standard models. The `schema` value and its nested fields are application data, not a replacement protocol model.

The reference implementation at [ryubyte/dsh-a2a](https://github.com/ryubyte/dsh-a2a) informs three behaviors: interrupted states return to callers, status Messages remain visible, and a follow-up can address an existing Task. Its server does not publish and resume a complete input-required tool interaction, and its outbound adapter does not preserve structured choices or the Task id, so no source code or private protocol type is imported from it.

<a id="testing"></a>
## Testing

Codec unit tests cover question rendering, schema encoding, structured validation, text fallback, multiple questions, single-select and multi-select options, custom answers, unknown ids, duplicate ids, missing answers, and unsupported selections.

Executor tests use a real user-questions waterfall with a controlled Session turn. They verify that only the exact A2A Agent is intercepted, the original tool Promise remains pending, a valid continuation resolves it once, and the same model turn produces the final Artifact.

Server integration tests cover blocking and streaming `input-required`, `tasks/get`, complete status Messages, history, structured and text continuations, invalid-answer retry, duplicate delivery, concurrent delivery, cancellation, timeout, and restart recovery.

Outbound client tests cover synchronous and streaming interrupted Tasks, status Message collection, `task_id` continuation, inferred context id, structured DataPart answers, text answers, and status Message FilePart materialization.

The existing Python interoperability fixture remains pinned to exact `a2a-sdk==0.3.2`. Python-to-DSH tests receive an input-required Task, retrieve it with `tasks/get`, submit structured and text answers, and observe final output. DSH-to-Python tests expose a Python input-required Task and verify that `call_a2a_agent` returns the interaction and resumes it with the same Task id.

The `business-a2a-call` keyless Session snapshot records the added tool input and result fields. Existing text, data, file, v0.3, and v1.0 regression tests remain.

Documentation updates cover the package README pair, Business Agent quick start, deployment and migration guidance, the model-visible tool fields, timeout behavior, restart behavior, and the distinction between `tasks/get` and nonexistent `message/get`. A same-change Agent Note owns the implemented rationale and shipped verification evidence.

<a id="acceptance-criteria"></a>
## Acceptance criteria

- An inbound DSH Agent question produces a persisted v0.3 Task with `state: "input-required"`, an Agent status Message, readable text, and the versioned question DataPart.
- The original blocking or streaming request returns at `input-required`, and `tasks/get` retrieves the same complete status Message afterward.
- A structured answer on the same Task resolves the original `ask_user_question` call and completes the original model turn without creating another Session prompt.
- A natural-language TextPart answer resumes a single question and remains usable for a combined multi-question response.
- Invalid answers keep the Task interrupted, preserve the questions, and return a stable safe validation error.
- `call_a2a_agent` returns remote interactions, accepts `task_id`, and continues remote Tasks through both streaming and non-streaming transports.
- Cancellation, timeout, duplicate answers, concurrent answers, and restart produce the documented single-winner states without leaked waits or duplicate tool results.
- Exact Python `a2a-sdk==0.3.2` passes both communication directions, including polling through `tasks/get`.
- Existing text, data, and file behavior remains available, and existing v1.0 tests continue to pass as regression coverage.

<a id="non-goals"></a>
## Non-goals

This change does not standardize an A2A form schema, require a private extension, add authentication, add a local human UI, resume suspended tool calls across process restart, release scheduler capacity while waiting, accept FileParts as question answers, or add a v1.0 interaction acceptance target. It does not change the shared DSH Web listener, Agent Loop, Session persistence format, or user-questions service.

<a id="references"></a>
## References

- [A2A v0.3 specification](https://a2a-protocol.org/v0.3.0/specification/)
- [A2A Python SDK 0.3.2](https://github.com/a2aproject/a2a-python/tree/v0.3.2)
- [A2A JavaScript SDK v0.3 compatibility guide](https://github.com/a2aproject/a2a-js/blob/main/docs/compatibility-v0_3.md)
- [DSH user-questions service](../../../packages/interaction/user-questions/README.md)
- [DSH ask-user tool](../../../packages/interaction/tool-ask-user/README.md)
