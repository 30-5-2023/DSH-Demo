# A2A v0.3 Input-Required Interaction Implementation Plan

English | [中文](2026-09-23-a2a-input-required-interaction-implementation.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let an inbound A2A v0.3 Task pause on `ask_user_question`, expose a durable `input-required` Message, resume the same DSH turn from a same-Task answer, and let `call_a2a_agent` return or continue remote interactions.

**Architecture:** Add one plugin-local interaction codec and broker. The broker associates the exact live DSH Session with its A2A execution, suspends the existing `ask_user_question` Promise in memory, and asks the executor to persist every state transition. Same-Task A2A messages are routed into that broker instead of starting another Session turn. The outbound client treats `input-required` as a settled call result and reuses the existing Part and file-materialization paths.

**Tech Stack:** TypeScript, Cordis waterfall events, `@a2a-js/sdk` 1.2.0 wire-compatible with A2A v0.3, exact Python `a2a-sdk==0.3.2`, Node test runner, DSH Session snapshots.

**Spec:** [A2A v0.3 Input-Required Interaction Design](../specs/2026-09-23-a2a-input-required-interaction-design.md)

## Global Constraints

- Keep all product changes under `business-agent/`; do not modify `packages/` or `apps/`.
- Implement only the approved A2A v0.3 behavior. Preserve v1 as a regression surface, not as a second interaction protocol.
- Treat `ryubyte/dsh-a2a` as a design reference only; do not import or vendor it.
- Use only standard A2A `Message`, `TextPart`, `DataPart`, `FilePart`, Task state, Task history, and same-Task `message/send`; do not add a private endpoint.
- Keep the original DSH model turn and `ask_user_question` Promise pending in memory while the Task is `input-required`.
- Store every model-visible question, answer, validation failure, state transition, and final result in the durable Task record.
- Continue to accept URL-only private-network deployments; do not add authentication in this change.
- Use deferred barriers and injected deadlines in tests. Do not use sleeps, fixed ports, process-global mutations, or teardown that leaves listeners, child processes, or Promises alive.
- Write a failing test before each implementation slice, observe the stated failure, add the minimum code, observe the stated pass, and commit that slice.

## Review Focus

Review these five failure classes before approving implementation. The tasks below add an explicit test for each one.

1. A recognized but invalid response `DataPart` next to valid-looking text must remain `input-required`; otherwise structured callers can accidentally bypass validation.
2. A continuation can arrive while the original request is draining, after its event stream returned, or concurrently with another answer; exactly one valid answer must resume exactly one model turn.
3. Cancellation, timeout, shutdown, or restart while the tool is waiting must reject the suspended Promise and release the scheduler slot, context lock, event bus, and Session operation exactly once.
4. `tasks/get`, blocking send, and streaming send must expose the same status Message; `historyLength` may trim history but must not remove `status.message`.
5. Text, data, and file Parts in a remote status Message must survive both synchronous and streaming outbound calls, and exact Python `a2a-sdk==0.3.2` must complete the same pause/query/resume flow.

---

### Task 1: Add the versioned question and answer codec

**Files:**

- Modify: `business-agent/plugins/a2a-bridge/package.json`
- Modify: `business-agent/plugins/a2a-bridge/src/types.ts`
- Create: `business-agent/plugins/a2a-bridge/src/interaction.ts`
- Create: `business-agent/plugins/a2a-bridge/test/interaction.test.mjs`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

```ts ignore-check
export const A2A_INPUT_REQUIRED_SCHEMA = 'urn:deepseek-harness:a2a:input-required:v1'
export const A2A_INPUT_RESPONSE_SCHEMA = 'urn:deepseek-harness:a2a:input-response:v1'

export interface A2AInteractionError {
  readonly code: 'A2A_INTERACTION_INVALID_RESPONSE'
  readonly message: string
}

export type ParsedInteractionAnswer =
  | { readonly ok: true; readonly answer: AskUserQuestionAnswer }
  | { readonly ok: false; readonly error: A2AInteractionError }

export function createInputRequiredMessage(input: {
  readonly taskId: A2ATaskId
  readonly contextId: A2AContextId
  readonly questions: readonly AskUserQuestionItem[]
  readonly error?: A2AInteractionError
}): Message

export function parseInteractionAnswer(
  message: Message,
  questions: readonly AskUserQuestionItem[],
): ParsedInteractionAnswer
```

- [ ] **Step 1: Write the failing codec tests.** Cover preservation of `id`, `question`, optional `header`, `detail`, `options`, `multiSelect`, and `intent`; readable TextPart generation; unique `messageId`; exact schema URNs; and a validation-error DataPart.
- [ ] **Step 2: Add answer tests.** Accept exact structured coverage and TextPart fallback; reject missing, duplicate, or unknown ids, unavailable selections, illegal multiple selections, a no-option answer without `custom`, and FilePart-only input. Assert that a recognized invalid DataPart does not fall back to adjacent text and that multi-question plain text maps only to the first question's `custom`.
- [ ] **Step 3: Run `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/interaction.test.mjs`.** Confirm failure because the codec and user-question types do not exist.
- [ ] **Step 4: Add `@deepseek-ai/dsh-user-questions` as a peer and dev dependency, define the schema constants and error/result types, and implement strict JSON narrowing at the A2A wire boundary.** Keep the codec pure; it must not access Cordis, storage, or process state.
- [ ] **Step 5: Re-run the focused build and test.** Confirm every Part and validation branch passes.
- [ ] **Step 6: Commit.**

```powershell
git add business-agent/plugins/a2a-bridge/package.json business-agent/plugins/a2a-bridge/src/types.ts business-agent/plugins/a2a-bridge/src/interaction.ts business-agent/plugins/a2a-bridge/test/interaction.test.mjs pnpm-lock.yaml
git commit -m "feat(business-agent): encode A2A input-required messages"
```

### Task 2: Bridge live DSH questions to one suspended A2A execution

**Files:**

- Modify: `business-agent/plugins/a2a-bridge/src/interaction.ts`
- Modify: `business-agent/plugins/a2a-bridge/src/index.ts`
- Modify: `business-agent/plugins/a2a-bridge/src/types.ts`
- Modify: `business-agent/plugins/a2a-bridge/test/interaction.test.mjs`
- Modify: `business-agent/plugins/a2a-bridge/test/plugin-lifecycle.test.mjs`

**Interfaces:**

```ts ignore-check
export interface A2AQuestionWindow extends Disposable {
  readonly taskId: A2ATaskId
  hasPendingQuestion(): boolean
  continue(message: Message): Promise<'accepted' | 'invalid' | 'duplicate'>
}

export interface A2AQuestionWindowOptions {
  readonly taskId: A2ATaskId
  readonly contextId: A2AContextId
  readonly sessionId: SessionId
  readonly signal: AbortSignal
  readonly publishInputRequired: (message: Message) => Promise<void>
  readonly publishWorking: () => Promise<void>
}

export class A2AQuestionBroker implements Disposable {
  open(options: A2AQuestionWindowOptions): A2AQuestionWindow
  answer(request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>
  find(taskId: A2ATaskId): A2AQuestionWindow | undefined
  [Symbol.dispose](): void
}
```

- [ ] **Step 1: Write failing broker tests with deferred barriers.** Prove that only the exact registered `request.agent.id` is intercepted, unrelated requests call `next()`, one question per Task may wait, `publishInputRequired` completes before the Promise remains suspended, and `publishWorking` completes before a valid answer resolves the Promise.
- [ ] **Step 2: Add race tests.** The first valid answer wins; the same answer `messageId` is idempotent; later concurrent answers return `duplicate`; invalid structured input republishes `input-required` with `A2A_INTERACTION_INVALID_RESPONSE`; abort and disposal reject the wait once and delete both Session and Task indexes.
- [ ] **Step 3: Run the focused tests.** Confirm failure because no broker or user-question listener exists.
- [ ] **Step 4: Implement the broker with one pending deferred object per window and two indexes, by `SessionId` and `A2ATaskId`.** Keep commit ordering inside `continue`: validate, await `publishWorking`, mark the message id consumed, then resolve the tool Promise. Route invalid input through `publishInputRequired` without resolving it.
- [ ] **Step 5: Inject `userQuestions` in `src/index.ts` and register `ctx.on('user-questions/request', ...)` as a Cordis-owned effect.** Dispose the listener and broker with the plugin runtime; do not change the shared user-question package.
- [ ] **Step 6: Re-run `interaction.test.mjs` and `plugin-lifecycle.test.mjs`.** Confirm interception, delegation, and quiescent cleanup pass without timers.
- [ ] **Step 7: Commit.**

```powershell
git add business-agent/plugins/a2a-bridge/src/interaction.ts business-agent/plugins/a2a-bridge/src/index.ts business-agent/plugins/a2a-bridge/src/types.ts business-agent/plugins/a2a-bridge/test/interaction.test.mjs business-agent/plugins/a2a-bridge/test/plugin-lifecycle.test.mjs
git commit -m "feat(business-agent): suspend A2A turns for DSH questions"
```

### Task 3: Persist `input-required` and resume the same executor turn

**Files:**

- Modify: `business-agent/plugins/a2a-bridge/src/executor.ts`
- Modify: `business-agent/plugins/a2a-bridge/src/types.ts`
- Modify: `business-agent/plugins/a2a-bridge/test/execution.test.mjs`

**Interfaces:**

```ts ignore-check
interface ExecutionRecord {
  // Existing fields stay unchanged.
  interaction?: A2AQuestionWindow
}

export interface DshAgentExecutorOptions {
  // Existing ports stay unchanged.
  readonly interactions: A2AQuestionBroker
}
```

- [ ] **Step 1: Extend the executor harness with an exact Session id and broker.** Write a failing test that starts `execute`, sends a scoped `AskUserQuestionRequest`, waits for the persisted `input-required` status, and asserts the original prompt and scheduler run are still pending.
- [ ] **Step 2: Add a failing continuation test.** Call `execute` again with the same `taskId` and a valid response Message. Assert no new Task, Session, scheduler admission, or `sessionController.prompt`; assert the Task moves to `working` before the tool Promise resolves, then the original turn completes normally.
- [ ] **Step 3: Add history and invalid-answer tests.** Refresh the Task from the repository before each transition so the SDK-appended answer Message is preserved; append each agent question or validation Message; keep the Task `input-required` after invalid structured input.
- [ ] **Step 4: Add concurrency tests.** Cover an answer arriving before the original request drains, two different valid answer Messages released together, retry of the same `messageId`, and a late answer after `working` or terminal state. Assert exactly one resolver, one second model phase, and one terminal write.
- [ ] **Step 5: Run `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/execution.test.mjs`.** Confirm the new tests fail because all same-Task input still follows new-turn admission.
- [ ] **Step 6: Open the question window inside `runTurn` with the existing deadline signal.** Its callbacks must reload the repository Task, append the agent Message, save `input-required` or `working`, update `record.task`, and publish the corresponding status event before returning.
- [ ] **Step 7: Add a continuation branch before new-task admission in `execute`.** Route `input-required` to the active window; attach a request that observes `working` to `record.done`; publish the latest terminal Task when completion won the race. Never call `scheduler.run` or `sessionController.prompt` from this branch.
- [ ] **Step 8: Re-run the focused test.** Confirm all state, history, ordering, and first-answer-wins assertions pass.
- [ ] **Step 9: Commit.**

```powershell
git add business-agent/plugins/a2a-bridge/src/executor.ts business-agent/plugins/a2a-bridge/src/types.ts business-agent/plugins/a2a-bridge/test/execution.test.mjs
git commit -m "feat(business-agent): resume A2A input-required tasks"
```

### Task 4: Complete query, stream, cancellation, timeout, and restart behavior

**Files:**

- Modify: `business-agent/plugins/a2a-bridge/src/executor.ts`
- Modify: `business-agent/plugins/a2a-bridge/src/request-handler.ts`
- Modify: `business-agent/plugins/a2a-bridge/src/store.ts`
- Modify: `business-agent/plugins/a2a-bridge/test/store.test.mjs`
- Modify: `business-agent/plugins/a2a-bridge/test/server.test.mjs`
- Modify: `business-agent/plugins/a2a-bridge/test/request-handler.test.mjs`
- Modify: `business-agent/plugins/a2a-bridge/test/execution.test.mjs`

- [ ] **Step 1: Add failing server tests for blocking and streaming send.** The original request must return at `input-required`, its event bus must stay reusable, `tasks/get` must return the identical `status.message`, and `historyLength: 0` must not erase that status Message.
- [ ] **Step 2: Add failing request-handler tests for same-Task answers.** Verify the handler appends the caller's answer Message, infers an omitted `contextId`, rejects a mismatched context, and never accepts continuation for an unknown or terminal Task.
- [ ] **Step 3: Add cancellation and deadline tests using barriers and an injected controlled deadline.** While waiting, assert the context lock and one `maxConcurrentContexts` slot remain occupied. Cancel during the wait and assert `canceled`; trigger the existing request deadline and assert `failed` with `A2A_EXECUTION_TIMEOUT`; in both cases assert one abort, one Session cancel, one terminal event, and released context/concurrency capacity.
- [ ] **Step 4: Extend the restart test.** Persist `input-required`, reopen the same storage root, run `markInterruptedTasksFailed`, and assert `failed` with `A2A_HOST_INTERRUPTED` while completed/canceled/failed Tasks remain unchanged.
- [ ] **Step 5: Run the four focused test files.** Confirm failures for query consistency, lifecycle settlement, or restart recovery.
- [ ] **Step 6: Include `input-required` in interrupted-task recovery and make the smallest executor/request-handler corrections required by the tests.** Do not reconstruct or resume the in-memory tool Promise after restart.
- [ ] **Step 7: Re-run the four focused test files.** Confirm no test relies on wall-clock sleeps or fixed ports and teardown reaches quiescence.
- [ ] **Step 8: Commit.**

```powershell
git add business-agent/plugins/a2a-bridge/src/store.ts business-agent/plugins/a2a-bridge/src/executor.ts business-agent/plugins/a2a-bridge/src/request-handler.ts business-agent/plugins/a2a-bridge/test/store.test.mjs business-agent/plugins/a2a-bridge/test/server.test.mjs business-agent/plugins/a2a-bridge/test/request-handler.test.mjs business-agent/plugins/a2a-bridge/test/execution.test.mjs
git commit -m "fix(business-agent): settle interrupted A2A waits"
```

### Task 5: Return and continue remote interactions from `call_a2a_agent`

**Files:**

- Modify: `business-agent/plugins/a2a-bridge/src/types.ts`
- Modify: `business-agent/plugins/a2a-bridge/src/client.ts`
- Modify: `business-agent/plugins/a2a-bridge/src/tool.ts`
- Modify: `business-agent/plugins/a2a-bridge/test/client-tool.test.mjs`

**Interfaces:**

```ts ignore-check
export interface CallA2AAgentInput {
  // Existing fields stay unchanged.
  readonly task_id?: string
}

export interface A2AInteractionResult {
  readonly text?: string
  readonly data?: readonly JsonValue[]
}

export interface CallA2AAgentResult {
  // Existing fields stay unchanged.
  readonly interaction?: A2AInteractionResult
}
```

- [ ] **Step 1: Add failing synchronous and streaming client tests.** A remote `input-required` Task must settle immediately, return `task_id`, readable interaction text, every DataPart value, and materialized FileParts in the existing `files` array. Final artifacts must remain in `output`/`files`, separate from `interaction`.
- [ ] **Step 2: Add a failing continuation test.** Passing `task_id` must put that id on the SDK request; a string `message` must become TextPart and a JSON `message` must become DataPart; the resumed final result must reuse the same Task id.
- [ ] **Step 3: Add aggregation race tests.** Capture `status.message` from Task responses and status-update events, including a stream that ends at `input-required`; do not wait for terminal state. Preserve an `auth-required` status as a non-hanging interrupted result without claiming v1 interaction support.
- [ ] **Step 4: Run the focused build and `client-tool.test.mjs`.** Confirm the client currently hangs or omits the status Message and the tool schema rejects `task_id`/`interaction`.
- [ ] **Step 5: Add `task_id` to the tool input schema and `interaction` to its output schema and safe presentation.** Extend request creation, settled-state detection, stream aggregation, and status-Message Part conversion. Reuse existing file publication/materialization and size policy; do not inline large files into interaction JSON.
- [ ] **Step 6: Re-run the focused test.** Confirm sync, stream, structured input, plain text, and status FilePart cases pass.
- [ ] **Step 7: Commit.**

```powershell
git add business-agent/plugins/a2a-bridge/src/types.ts business-agent/plugins/a2a-bridge/src/client.ts business-agent/plugins/a2a-bridge/src/tool.ts business-agent/plugins/a2a-bridge/test/client-tool.test.mjs
git commit -m "feat(business-agent): continue remote A2A interactions"
```

### Task 6: Prove the complete flow through the real Loader and Python 0.3.2

**Files:**

- Modify: `business-agent/tests/fixtures/a2a-scripted-llm.ts`
- Modify: `business-agent/tests/a2a-vertical-slice.test.mjs`
- Modify: `business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs`
- Modify: `business-agent/tests/fixtures/a2a-python-v032-peer.py`

- [ ] **Step 1: Extend the scripted LLM with an `ask_user_question` scenario.** Its first phase emits the tool call with two questions and choices; after the tool result is logged, its second phase emits a deterministic final answer containing the selected values.
- [ ] **Step 2: Add a failing real-Loader vertical slice.** Start the bundle on port `0`, send through the official A2A client, assert `input-required`, retrieve it through `tasks/get`, send a structured response on the same Task, and assert completion, one durable DSH Session, preserved Task history, and no lingering listener after Loader disposal.
- [ ] **Step 3: Extend the exact-version Python peer in both directions.** The Python client must parse TextPart/DataPart from the JavaScript question, query the Task, answer it, and observe completion. The Python server must emit `input-required`; the JavaScript client must return `interaction`, answer with `task_id`, and observe final text. Include a status FilePart so the JavaScript side proves existing local-file materialization.
- [ ] **Step 4: Keep the subprocess deterministic.** Allocate a port from an owned listener, use a readiness line instead of sleeping, bound each protocol step, close stdin/listeners, terminate only the owned child, await exit, and preserve stdout/stderr on failure.
- [ ] **Step 5: Run `pnpm --filter @deepseek-ai/dsh-business-tests test` and the exact-version verifier.** Confirm the new scenarios fail before the implementation is complete, then pass with `a2a-sdk==0.3.2`.

```powershell
pnpm run verify:a2a-python-v032
pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build
node --test business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs
```

- [ ] **Step 6: Commit.**

```powershell
git add business-agent/tests/fixtures/a2a-scripted-llm.ts business-agent/tests/a2a-vertical-slice.test.mjs business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs business-agent/tests/fixtures/a2a-python-v032-peer.py
git commit -m "test(business-agent): cover A2A question continuations"
```

### Task 7: Update snapshots, operator docs, and the A2A Agent Note

**Files:**

- Modify: `snapshots/session/business-a2a-call/tool-schemas.expected.json`
- Modify: `snapshots/session/business-a2a-call/session.v3.jsonl`
- Modify: `snapshots/session/business-a2a-call/snapshot.yml`
- Modify: `business-agent/tests/fixtures/snapshot-a2a-call.ts`
- Modify: `business-agent/plugins/a2a-bridge/README.md`
- Modify: `business-agent/plugins/a2a-bridge/README.zh.md`
- Modify: `business-agent/plugins/a2a-bridge/README.i18n.yaml`
- Modify: `business-agent/README.md`
- Modify: `business-agent/README.zh.md`
- Modify: `business-agent/README.i18n.yaml`
- Modify: `business-agent/migration/README.md`
- Modify: `business-agent/migration/README.zh.md`
- Modify: `business-agent/migration/README.i18n.yaml`
- Modify: `.agents/notes/implemented/feature/2026-09-20-a2a-bridge.md`
- Modify: `.agents/notes/implemented/feature/2026-09-20-a2a-bridge.zh.md`
- Modify: `.agents/notes/implemented/feature/2026-09-20-a2a-bridge.i18n.yaml`

- [ ] **Step 1: Update the recorded scenario and expected schemas.** Record `task_id` on tool input, `interaction` on tool output, and one deterministic `input-required` result followed by same-Task completion so model-visible behavior is reconstructable from the Session log.
- [ ] **Step 2: Run `pnpm run test:snapshot -t business-a2a-call`.** Inspect the semantic diff; do not hand-normalize ids or timestamps that the snapshot harness owns.
- [ ] **Step 3: Update the English and Chinese plugin and deployment docs line-for-line.** Document the two schema URNs, structured and plain-text answers, `tasks/get` and the absence of `message/get`, outbound continuation, local-file behavior, the five-minute default timeout, restart failure, concurrency retention, and the exact Python 0.3.2 verifier command. State that FilePart is returned with the interaction but cannot answer `ask_user_question`.
- [ ] **Step 4: Extend the existing A2A Agent Note instead of creating a competing decision record.** Record the selected in-memory suspension plus durable Task-state design, alternatives rejected, failure semantics, and verification evidence. Keep current-state prose and avoid review narration.
- [ ] **Step 5: Re-record all three translation-pair sidecars and run documentation checks.**

```powershell
pnpm run verify-translation-pairing --write business-agent/plugins/a2a-bridge/README.md
pnpm run verify-translation-pairing --write business-agent/README.md
pnpm run verify-translation-pairing --write business-agent/migration/README.md
pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-09-20-a2a-bridge.md
pnpm run test:docs
pnpm run doc-sync
```

- [ ] **Step 6: Commit.**

```powershell
git add snapshots/session/business-a2a-call business-agent/tests/fixtures/snapshot-a2a-call.ts business-agent/plugins/a2a-bridge/README.md business-agent/plugins/a2a-bridge/README.zh.md business-agent/plugins/a2a-bridge/README.i18n.yaml business-agent/README.md business-agent/README.zh.md business-agent/README.i18n.yaml business-agent/migration/README.md business-agent/migration/README.zh.md business-agent/migration/README.i18n.yaml .agents/notes/implemented/feature/2026-09-20-a2a-bridge.md .agents/notes/implemented/feature/2026-09-20-a2a-bridge.zh.md .agents/notes/implemented/feature/2026-09-20-a2a-bridge.i18n.yaml
git commit -m "docs(business-agent): document A2A input-required flow"
```

### Task 8: Run focused gates, review the diff, and prepare the branch

**Files:**

- Review: every file changed in Tasks 1-7

- [ ] **Step 1: Invoke `dsh-pre-push-checks` and select checks from the actual outgoing diff.** At minimum retain the focused package, bundle, vertical, snapshot, Python, type, lint, and documentation signals below; add a gate only when the diff requires it.

```powershell
pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build
pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test
pnpm --filter @deepseek-ai/dsh-business-bundle test
pnpm --filter @deepseek-ai/dsh-business-tests test
pnpm run verify:a2a-python-v032
pnpm run test:snapshot -t business-a2a-call
pnpm run typecheck
pnpm run lint
pnpm run test:docs
pnpm run doc-sync
git diff --check
```

- [ ] **Step 2: Invoke `superpowers:requesting-code-review`.** Review protocol compliance, state ordering, race settlement, Part conversion, cleanup, exact-version Python behavior, and the five Review Focus cases. Turn each accepted finding into a failing regression test before changing production code.
- [ ] **Step 3: Re-run only the checks affected by review fixes, then the selected pre-push set once.** Do not repeat already-passing unrelated repository-wide suites.
- [ ] **Step 4: Inspect `git status --short`, `git diff --stat`, and the commit list.** Confirm no credentials, generated environments, local file payloads, or unrelated edits are present.
- [ ] **Step 5: Invoke `superpowers:verification-before-completion`, report the exact commands and outcomes, then invoke `superpowers:finishing-a-development-branch`.** Do not push, merge, or rewrite the remote branch until the user chooses that integration action.

## Plan Self-Review

- Every acceptance criterion in the approved design maps to a task and a named test.
- The plan keeps the extension plugin-local and updates the complete Service Definition / Provider / Consumer surface without editing `packages/` or `apps/`.
- The plan separates structured interaction data from final artifacts while reusing existing file handling.
- Every asynchronous test uses barriers, injected deadlines, owned listeners, and awaited teardown.
- Every model-visible change includes Session snapshot coverage and bilingual operator documentation.
- No task contains placeholder filenames, unspecified implementation choices, or an unowned cross-process resource.
