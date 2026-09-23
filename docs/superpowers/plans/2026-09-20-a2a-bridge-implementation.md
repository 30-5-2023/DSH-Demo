# A2A Bridge Implementation Plan

English | [中文](2026-09-20-a2a-bridge-implementation.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Business Agent plugin that exposes one A2A Protocol v1.0 agent and registers a `call_a2a_agent` tool that calls another agent from its Agent Card URL.

**Architecture:** A private Express application hosts the official A2A SDK handlers and is mounted through the existing `ctx.webServer`; a durable storage-domain repository maps A2A contexts and tasks to ordinary DSH Sessions; a per-context scheduler and Session event tracker translate one A2A request into one correlated DSH turn. The outbound path uses the SDK client with a bounded fetch implementation and returns a compact model-visible result.

**Technology:** TypeScript, Cordis, `@a2a-js/sdk` 1.2.0, Express 5.2.1, `@types/express` 5.0.6, Zod/Schemastery, Node test runner, DSH recorded-session snapshots.

**Approved design:** [A2A Bridge Design](../specs/2026-09-20-a2a-bridge-design.md)

## Global Constraints

- Perform implementation in a real Git checkout. This copied workspace currently has no `.git`; do not start Task 1 until the repository metadata is restored or the work is moved to the canonical checkout.
- Keep all product code under `business-agent/`; do not modify `packages/` or `apps/`.
- Implement A2A v1.0 JSON-RPC only: Agent Card, `SendMessage`, `SendStreamingMessage`, `GetTask`, and `CancelTask`.
- Expose one configurable Agent Card per process. Do not add a registry, outbound credentials, push notifications, task listing, resubscription, files, media, gRPC, or HTTP+JSON.
- Map each A2A `contextId` to one durable DSH Session. Serialize work inside one context and permit bounded concurrency across contexts.
- Default to loopback. Require a non-empty Bearer token when `ctx.webServer.host` is `0.0.0.0`; keep the Agent Card public and protect only `/a2a`.
- Permit direct private HTTP(S) Agent Card URLs. Reject credentials, fragments, HTTPS-to-HTTP redirects, excess redirects, timeouts, and response bodies over the configured limit.
- Do not log Authorization values, full remote bodies, complete prompts, reasoning, or tool calls. Log stable correlation identifiers and safe error summaries.
- Use branded ids at internal boundaries, strict TypeScript, Cordis effects for every registration, and awaited quiescent teardown.
- Write a failing test before each implementation slice, observe the stated failure, add the minimum code, observe the stated pass, then commit that slice.

## Review Focus

Review these five failure classes before approving implementation. The tasks below add an explicit test for each one.

1. A duplicate `messageId` arriving before the first response can otherwise create two Tasks or prompt the Session twice. `request-handler.test.mjs` must hold the first execution at a barrier, submit the retry, and assert one Task id, one Session prompt, and two equivalent protocol responses.
2. An SSE disconnect can otherwise cancel or orphan the underlying Task. `server.test.mjs` must destroy the streaming client after `working`, release the Agent, and retrieve the completed Task through `GetTask`.
3. Cancellation races can otherwise cancel an unrelated turn or write two terminal states. `execution.test.mjs` must cover queued, active, already-terminal, and cancel-versus-complete races and assert one terminal transition.
4. A Host restart can otherwise leave `submitted` or `working` Tasks permanently live. `store.test.mjs` must reopen the same storage root, mark interrupted Tasks failed with `A2A_HOST_INTERRUPTED`, preserve final Tasks, and reuse the context's Session id.
5. Redirects, oversized bodies, malformed Data Parts, or invalid requested JSON can otherwise reach the model or leak remote content. `conversion-safe-fetch.test.mjs` must assert pre-admission rejection, bounded diagnostics, and zero Session prompts.

## File Map

Create the plugin package:

- `business-agent/plugins/a2a-bridge/package.json` — package boundary and exact runtime dependencies.
- `business-agent/plugins/a2a-bridge/tsconfig.json` — Host-only project references.
- `business-agent/plugins/a2a-bridge/tsdown.config.ts` — ESM Node 2024 bundle with DSH packages externalized.
- `business-agent/plugins/a2a-bridge/src/types.ts` — branded ids, durable records, public client result, and internal ports.
- `business-agent/plugins/a2a-bridge/src/config.ts` — Schemastery schema and deployment-aware validation.
- `business-agent/plugins/a2a-bridge/src/card.ts` — one validated A2A v1.0 Agent Card.
- `business-agent/plugins/a2a-bridge/src/store.ts` — storage-domain repository and SDK `TaskStore` adapter.
- `business-agent/plugins/a2a-bridge/src/conversion.ts` — Part conversion, strict JSON output, and safe failures.
- `business-agent/plugins/a2a-bridge/src/safe-fetch.ts` — timeout, redirect, scheme, and byte-limit enforcement.
- `business-agent/plugins/a2a-bridge/src/scheduler.ts` — bounded cross-context execution and per-context FIFO.
- `business-agent/plugins/a2a-bridge/src/run-tracker.ts` — request-to-turn correlation and assistant text streaming.
- `business-agent/plugins/a2a-bridge/src/executor.ts` — SDK `AgentExecutor` backed by Session control.
- `business-agent/plugins/a2a-bridge/src/request-handler.ts` — operation allowlist and in-flight/durable deduplication.
- `business-agent/plugins/a2a-bridge/src/server.ts` — private Express app, Bearer middleware, SDK handlers, and route bridge.
- `business-agent/plugins/a2a-bridge/src/client.ts` — official SDK client creation and result aggregation.
- `business-agent/plugins/a2a-bridge/src/tool.ts` — model-visible `call_a2a_agent` definition.
- `business-agent/plugins/a2a-bridge/src/index.ts` — Cordis lifecycle composition only.

Create focused tests and documentation:

- `business-agent/plugins/a2a-bridge/test/config-card.test.mjs`
- `business-agent/plugins/a2a-bridge/test/store.test.mjs`
- `business-agent/plugins/a2a-bridge/test/conversion-safe-fetch.test.mjs`
- `business-agent/plugins/a2a-bridge/test/scheduler-run-tracker.test.mjs`
- `business-agent/plugins/a2a-bridge/test/execution.test.mjs`
- `business-agent/plugins/a2a-bridge/test/request-handler.test.mjs`
- `business-agent/plugins/a2a-bridge/test/server.test.mjs`
- `business-agent/plugins/a2a-bridge/test/client-tool.test.mjs`
- `business-agent/plugins/a2a-bridge/README.md`, `README.zh.md`, and `README.i18n.yaml`

Modify integration surfaces:

- `pnpm-lock.yaml` — resolved exact A2A and Express graph.
- `business-agent/bundle/package.json` — depend on the bridge package.
- `business-agent/bundle/cordis.patch.yml` — enable one loopback A2A instance.
- `business-agent/bundle/test/config.mjs` — own exact bundle order and configuration.
- `business-agent/bundle/README.md`, `README.zh.md`, and `README.i18n.yaml` — deployment and URL-only usage.
- `business-agent/tests/package.json` — include the new vertical slice.
- `business-agent/tests/a2a-vertical-slice.test.mjs` — real Loader composition with scripted LLM only.
- `business-agent/tests/fixtures/snapshot-a2a-call.ts` — deterministic two-agent tool-call fixture.
- `snapshots/session/business-a2a-call/*` — recorded tool schema, call, result, prompt, and Session log.
- `business-agent/README.md`, `README.zh.md`, and `README.i18n.yaml` — top-level quick start.
- `.agents/notes/proposed/feature/2026-09-20-a2a-bridge.md`, `.zh.md`, and `.i18n.yaml` — proposed note created before code; move the completed record to `implemented/feature/` in Task 9.

## Task 1: Scaffold the Package, Configuration, Agent Card, and Proposed Note

**Files:** Create the package metadata, `src/types.ts`, `src/config.ts`, `src/card.ts`, `test/config-card.test.mjs`, plugin README triplet, and proposed Agent Note triplet listed above; modify `pnpm-lock.yaml`.

**Interfaces:**

```ts ignore-check
export type A2AContextId = Brand<string, 'A2AContextId'>
export type A2ATaskId = Brand<string, 'A2ATaskId'>
export type A2AMessageId = Brand<string, 'A2AMessageId'>

export interface ResolvedA2AConfig {
  readonly route: string
  readonly cardPath: '/.well-known/agent-card.json'
  readonly publicBaseUrl: URL
  readonly bearerToken?: string
  readonly requestTimeoutMs: number
  readonly outboundTimeoutMs: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly maxConcurrentContexts: number
  readonly agentPreset?: string
  readonly agentCard: AgentCard
}

export function resolveConfig(config: Config, deployment: { host: string; port: number; env: NodeJS.ProcessEnv }): ResolvedA2AConfig
export function buildAgentCard(config: ResolvedA2AConfig): AgentCard
```

- [ ] Add `package.json`, Host `tsconfig.json`, and `tsdown.config.ts`. Pin `@a2a-js/sdk` to `1.2.0`, `express` to `5.2.1`, and `@types/express` to `5.0.6`; use workspace dependencies for Cordis, Session Controller, Session, storage-domain, tools, webserver, brand, Schemastery, and Zod.
- [ ] Write tests that reject non-HTTP public URLs, credentials, query/fragment in `publicBaseUrl`, non-absolute routes, empty skills, out-of-range limits, missing token on `0.0.0.0`, and an empty referenced token. Assert loopback defaults, Card URLs, modes, capabilities, and Bearer declaration.
- [ ] Run `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test`; expect failure because the package and exports do not exist.
- [ ] Implement the typed config and Card builder. Resolve `publicBaseUrl` from `127.0.0.1` plus the actual listener port when omitted; require it for `0.0.0.0`; read the token once from the named environment variable.
- [ ] Add concise bilingual plugin README and a proposed feature Agent Note with `Problem`, `Proposal`, `Alternatives considered`, `Acceptance criteria`, and `Risks`; generate pairing hashes after final text.
- [ ] Run the focused package test, `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build`, `pnpm verify-agent-note-format`, and `pnpm verify-translation-pairing`; expect all to pass.
- [ ] Commit with `git add business-agent/plugins/a2a-bridge .agents/notes/proposed/feature/2026-09-20-a2a-bridge.* pnpm-lock.yaml && git commit -m "feat(business-agent): scaffold A2A bridge"`.

## Task 2: Add Durable Context and Task Storage

**Files:** Create `src/store.ts` and `test/store.test.mjs`; extend `src/types.ts`.

**Interfaces:**

```ts ignore-check
export interface A2ARepository {
  getContext(contextId: A2AContextId): Promise<A2AContextRecord | undefined>
  createContext(record: A2AContextRecord): Promise<void>
  getTask(taskId: A2ATaskId): Promise<Task | undefined>
  getTaskByMessageId(messageId: A2AMessageId): Promise<Task | undefined>
  saveTask(task: Task, inputMessageId?: A2AMessageId): Promise<void>
  markInterruptedTasksFailed(now: string): Promise<number>
  close(): Promise<void>
}

export class DomainTaskStore implements TaskStore {
  save(task: Task, context?: ServerCallContext): Promise<void>
  load(taskId: string, context?: ServerCallContext): Promise<Task | undefined>
  list(params: ListTasksRequest, context?: ServerCallContext): Promise<ListTasksResult>
}
```

- [ ] Define an `a2a_bridge` version-1 domain with `contexts` and `tasks` tables. Store protobuf Tasks using `Task.toJSON` and validate/restore them with `Task.fromJSON`; keep `inputMessageId` indexed by an explicit scan guarded by the repository mutex because the domain table has no secondary index.
- [ ] Write tests for context uniqueness, unknown lookup, task round-trip, message-id lookup, legal state progression, rejected terminal rewrites, and final Artifact retention.
- [ ] Add the restart test from Review Focus item 4 using one temporary storage root opened twice.
- [ ] Run `node --test business-agent/plugins/a2a-bridge/test/store.test.mjs`; expect missing repository exports.
- [ ] Implement repository writes so context/task relationships are durable before admission. Make `list()` throw the SDK unsupported-operation error because public task listing is out of scope.
- [ ] Run the focused test and the package build; expect pass.
- [ ] Commit with `git add business-agent/plugins/a2a-bridge/src/types.ts business-agent/plugins/a2a-bridge/src/store.ts business-agent/plugins/a2a-bridge/test/store.test.mjs && git commit -m "feat(business-agent): persist A2A contexts and tasks"`.

## Task 3: Implement Part Conversion and Bounded Fetch

**Files:** Create `src/conversion.ts`, `src/safe-fetch.ts`, and `test/conversion-safe-fetch.test.mjs`.

**Interfaces:**

```ts
interface Message {}
type UserContent = unknown
interface Artifact {}

export declare function a2aMessageToPrompt(message: Message): { content: UserContent; requestedMode: 'text' | 'json' }
export declare function assistantTextToArtifact(text: string, mode: 'text' | 'json'): Artifact
export declare function createBoundedFetch(policy: FetchPolicy): typeof fetch

export interface FetchPolicy {
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly maxRedirects: number
  readonly signal?: AbortSignal
}
```

- [ ] Write conversion tests for ordered Text Parts, Data Parts serialized as labeled untrusted data, unsupported Part kinds, empty messages, strict single-object JSON output, arrays/scalars/trailing text, and safe error codes.
- [ ] Write local-server fetch tests for embedded credentials, fragments, non-HTTP schemes, redirect loops, HTTPS downgrade detection through a synthetic fetch, timeout, caller abort, exact byte limit, oversized chunked body, invalid JSON, and private `127.0.0.1` acceptance.
- [ ] Add Review Focus item 5 and assert the injected Session prompt spy remains at zero for every pre-admission failure.
- [ ] Run `node --test business-agent/plugins/a2a-bridge/test/conversion-safe-fetch.test.mjs`; expect missing exports.
- [ ] Implement conversion without interpolating remote data into system instructions. Implement redirects manually with `redirect: 'manual'`, merge timeout and caller abort signals, cancel oversized response bodies, and redact URL credentials from errors.
- [ ] Run the focused test and package build; expect pass.
- [ ] Commit with `git add business-agent/plugins/a2a-bridge/src/conversion.ts business-agent/plugins/a2a-bridge/src/safe-fetch.ts business-agent/plugins/a2a-bridge/test/conversion-safe-fetch.test.mjs && git commit -m "feat(business-agent): validate A2A content and remote fetches"`.

## Task 4: Build the Per-Context Scheduler and Session Turn Tracker

**Files:** Create `src/scheduler.ts`, `src/run-tracker.ts`, and `test/scheduler-run-tracker.test.mjs`; extend `src/types.ts`.

**Interfaces:**

```ts ignore-check
export interface ContextScheduler {
  run<T>(taskId: A2ATaskId, contextId: A2AContextId, operation: (signal: AbortSignal) => Promise<T>): Promise<T>
  cancel(taskId: A2ATaskId): 'queued' | 'active' | 'missing'
  close(): Promise<void>
}

export interface SessionTurnTracker {
  track(input: {
    sessionId: SessionId
    requestId: SessionRequestId
    signal: AbortSignal
    onTextDelta(delta: string): void
  }): Promise<{ turn: number; text: string; reason: TurnEndReason }>
  close(): Promise<void>
}
```

- [ ] Write scheduler tests proving FIFO within one context, configured concurrency across contexts, queued removal, active abort, admission rejection after close, and close waiting for active operations.
- [ ] Write tracker tests with interleaved Sessions and turns. Correlate `user/message.data.source.rpcId` to the request, then own its turn; stream only matching `agent/assistant-stream` attempts and collect durable `assistant/message` text blocks until that turn's `turn/end`.
- [ ] Run `node --test business-agent/plugins/a2a-bridge/test/scheduler-run-tracker.test.mjs`; expect missing scheduler/tracker exports.
- [ ] Implement one Cordis `session/event` listener plus one `agent/assistant-stream` listener, a map keyed by Session/request, and deterministic cleanup on settle or abort. Do not use process-wide Agent idle state.
- [ ] Run the focused test and package build; expect pass.
- [ ] Commit with `git add business-agent/plugins/a2a-bridge/src/types.ts business-agent/plugins/a2a-bridge/src/scheduler.ts business-agent/plugins/a2a-bridge/src/run-tracker.ts business-agent/plugins/a2a-bridge/test/scheduler-run-tracker.test.mjs && git commit -m "feat(business-agent): correlate A2A tasks with session turns"`.

## Task 5: Implement Inbound Execution, State Transitions, and Cancellation

**Files:** Create `src/executor.ts` and `test/execution.test.mjs`; modify `src/store.ts`, `src/conversion.ts`, and `src/types.ts`.

**Interfaces:**

```ts
interface AgentExecutor {}
interface RequestContext {}
interface ExecutionEventBus {}

export declare class DshAgentExecutor implements AgentExecutor {
  execute(request: RequestContext, events: ExecutionEventBus): Promise<void>
  cancelTask(taskId: string, events: ExecutionEventBus): Promise<void>
}
```

- [ ] Write tests that require the first published event to be a submitted Task, then `working`, Artifact update, and exactly one terminal status. Cover new context/session creation, known-context continuation, unknown context, Session create/prompt failure, timeout, text output, and requested JSON output.
- [ ] Add Review Focus item 3: hold queued and active operations at explicit barriers, race cancel with completion, and assert that only the owning Session's active turn receives `sessionController.cancel({ sessionId })`.
- [ ] Run `node --test business-agent/plugins/a2a-bridge/test/execution.test.mjs`; expect missing executor export.
- [ ] Implement Task ids and context ids with `crypto.randomUUID()`. Persist context and submitted Task before `sessionController.prompt({ mode: 'queue' })`; register the tracker before prompt admission; emit final Artifact before terminal status; map stable failures without prompt or credential text.
- [ ] On timeout, abort the tracker, cancel the active Session, wait for scheduler settlement, and write `failed`. On queued cancellation write `canceled` without Session cancellation. Return an existing terminal Task unchanged.
- [ ] Run the focused test and package build; expect pass.
- [ ] Commit with `git add business-agent/plugins/a2a-bridge/src/types.ts business-agent/plugins/a2a-bridge/src/store.ts business-agent/plugins/a2a-bridge/src/conversion.ts business-agent/plugins/a2a-bridge/src/executor.ts business-agent/plugins/a2a-bridge/test/execution.test.mjs && git commit -m "feat(business-agent): execute A2A tasks through sessions"`.

## Task 6: Add the Operation Allowlist and Duplicate Suppression

**Files:** Create `src/request-handler.ts` and `test/request-handler.test.mjs`; modify `src/store.ts`.

**Interfaces:**

```ts ignore-check
export class BridgeRequestHandler extends DefaultRequestHandler {
  sendMessage(params: SendMessageRequest, context?: ServerCallContext): Promise<SendMessageResult>
  sendMessageStream(params: SendMessageRequest, context?: ServerCallContext): AsyncGenerator<StreamResponse>
  listTasks(): Promise<never>
  subscribeToTask(): Promise<never>
}
```

- [ ] Write tests that allow exactly send, streaming send, get, and cancel; assert listing, resubscription, push configuration, and extended Card requests return the SDK's standard unsupported-operation failure.
- [ ] Add Review Focus item 1 with a first-request barrier and simultaneous sync/stream duplicate retries. Assert one durable Task, one prompt, identical Task ids, and no replayed partial stream after the durable Task is terminal.
- [ ] Run `node --test business-agent/plugins/a2a-bridge/test/request-handler.test.mjs`; expect missing handler export.
- [ ] Implement a message-id single-flight map before delegating to `DefaultRequestHandler`; consult the durable repository before creating a flight. For a duplicate in progress, wait for its Task and return/publish that Task; for a terminal duplicate, return it immediately.
- [ ] Construct the parent with `new DefaultRequestHandler(agentCard, taskStore, executor)` and override only the behavior needed for the allowlist and deduplication.
- [ ] Run the focused test and package build; expect pass.
- [ ] Commit with `git add business-agent/plugins/a2a-bridge/src/store.ts business-agent/plugins/a2a-bridge/src/request-handler.ts business-agent/plugins/a2a-bridge/test/request-handler.test.mjs && git commit -m "feat(business-agent): deduplicate A2A requests"`.

## Task 7: Mount the SDK Server on the Shared Web Listener

**Files:** Create `src/server.ts` and `test/server.test.mjs`; modify `src/index.ts` and `test/config-card.test.mjs`.

**Interfaces:**

```ts ignore-check
export interface A2AServer {
  readonly cardUrl: URL
  readonly rpcUrl: URL
  close(): Promise<void>
}

export function createA2AServer(ctx: Context, config: ResolvedA2AConfig, handler: RequestHandler): A2AServer
```

- [ ] Write official-client integration tests for public Card discovery, synchronous send, SSE streaming order, get, cancel, method/media-type rejection, JSON body limit, 401 with `WWW-Authenticate`, and timing-safe exact Bearer acceptance.
- [ ] Add Review Focus item 2: disconnect SSE after `working`, finish the scripted Agent turn, and verify `GetTask` returns the completed Artifact.
- [ ] Run `node --test business-agent/plugins/a2a-bridge/test/server.test.mjs`; expect missing server/entry exports.
- [ ] Create a private `express()` app with `agentCardHandler` and `jsonRpcHandler` from `@a2a-js/sdk/server/express`. Register exact Card and RPC routes through `ctx.webServer.register`; adapt the existing request/response objects without opening another listener.
- [ ] Apply authentication only to the RPC route, use `express.json({ limit: maxRequestBytes })`, compare equal-length token buffers with `timingSafeEqual`, and install error middleware that returns safe HTTP failures without echoing bodies.
- [ ] Compose repository recovery, scheduler, tracker, executor, handler, server, and later tool registration in `src/index.ts`. Register cleanup as Cordis effects in reverse dependency order and await active execution, streams, routes, and storage closure.
- [ ] Run the focused test and package build; expect pass.
- [ ] Commit with `git add business-agent/plugins/a2a-bridge/src/server.ts business-agent/plugins/a2a-bridge/src/index.ts business-agent/plugins/a2a-bridge/test/server.test.mjs business-agent/plugins/a2a-bridge/test/config-card.test.mjs && git commit -m "feat(business-agent): expose A2A protocol routes"`.

## Task 8: Add the Outbound Client and `call_a2a_agent` Tool

**Files:** Create `src/client.ts`, `src/tool.ts`, and `test/client-tool.test.mjs`; modify `src/index.ts` and the plugin README triplet.

**Interfaces:**

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface CallA2AAgentInput {
  readonly agent_card_url: string
  readonly message: string | JsonValue
  readonly context_id?: string
  readonly stream?: boolean
  readonly accepted_output_mode?: 'text' | 'json'
  readonly timeout_ms?: number
}

export interface CallA2AAgentResult {
  readonly context_id?: string
  readonly task_id?: string
  readonly state: string
  readonly output?: string | JsonValue
  readonly failure?: { readonly code: string; readonly message: string }
}
```

- [ ] Start an ephemeral official-SDK server on `127.0.0.1:0` in tests. Cover sync, stream aggregation, continuation by returned context id, JSON input/output, remote failure, timeout, caller cancellation with bounded `CancelTask`, response-size rejection, and Card refetch on every call.
- [ ] Assert the tool schema has exactly the six approved inputs and no Authorization field; assert `presentCall`, `presentResult`, and rendered output expose ids/state/output but no remote stack or full response body.
- [ ] Run `node --test business-agent/plugins/a2a-bridge/test/client-tool.test.mjs`; expect missing client/tool exports.
- [ ] Build `ClientFactory` with `DefaultAgentCardResolver({ fetchImpl })` and `JsonRpcTransportFactory({ fetchImpl })`; use `createFromUrl(cardUrl.href, '')`. For streams, aggregate `payload.$case` values `message`, `task`, `statusUpdate`, and `artifactUpdate` until terminal state.
- [ ] Define and register `call_a2a_agent` through `ctx.tools.register(defineTool(...))`. Clamp `timeout_ms` to the configured maximum; when local cancellation occurs after a Task id is known, issue one bounded remote cancel attempt and then settle locally.
- [ ] Document the exact URL-only call and the no-outbound-auth limitation in both README languages; update pairing hashes.
- [ ] Run the focused test, package build, and translation pairing verification; expect pass.
- [ ] Commit with `git add business-agent/plugins/a2a-bridge && git commit -m "feat(business-agent): add outbound A2A tool"`.

## Task 9: Wire the Bundle, Prove the Vertical Slice, and Finalize Documentation

**Files:** Modify all bundle/test/doc files and create the fixture, snapshot tree, and implemented Agent Note files listed in the File Map.

**Interfaces:** The bundle entry must use `id: business-a2a-bridge`, package `@deepseek-ai/dsh-business-a2a-bridge`, route `/a2a`, and loopback `publicBaseUrl: http://127.0.0.1:3081`. The checked-in default omits `bearerTokenEnv` so two local instances can call each other by URL only; production intranet documentation must show the token environment configuration.

- [ ] Extend `business-agent/bundle/test/config.mjs` first so it expects the bridge after existing business plugins and owns the complete default config; run `pnpm --filter @deepseek-ai/dsh-business-agent test` and observe the expected configuration failure.
- [ ] Add the bundle dependency and Cordis entry, then rerun the bundle build/test and expect pass.
- [ ] Write `a2a-vertical-slice.test.mjs` to boot the real Loader profile, discover the Card with the official client, send twice in one context and once in another, stream one response, get one Task, cancel one barrier-held Task, restart over the same storage root, and verify context reuse. Bind fixtures to `127.0.0.1:0`; use explicit barriers and unique ids, not sleeps or process-global mutation.
- [ ] Run `node --test business-agent/tests/a2a-vertical-slice.test.mjs`; expect failure before the fixture/composition is complete, then complete only the Loader and scripted-LLM plumbing needed by the assertions and rerun to pass.
- [ ] Add the deterministic `business-a2a-call` recorded-session case. Record through the `dsh` profile, never a new executable; verify the snapshot owns the `call_a2a_agent` schema, call/result, prompt, and durable Session events without credentials or reasoning.
- [ ] Update the bundle and top-level Business Agent README pairs with startup, Card/RPC URLs, token rules, two-instance URL-only example, supported operations, limits, and non-goals. Keep one physical line per paragraph and refresh each sidecar hash.
- [ ] Move the proposed Agent Note to `.agents/notes/implemented/feature/` and rewrite `Proposal` as `Decision`, `Acceptance criteria` as `Consequences`, retaining `Problem` and `Alternatives considered`; update its translation sidecar.
- [ ] Run focused verification: `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test`, its build, bundle build/test, and `pnpm --filter @deepseek-ai/dsh-business-agent-tests test`.
- [ ] Run snapshot and repository verification selected by `dsh-pre-push-checks`: the recorded-session replay for `business-a2a-call`, `pnpm typecheck`, `pnpm lint`, `pnpm verify-agent-note-format`, `pnpm verify-agent-note-classification`, `pnpm verify-translation-pairing`, `pnpm verify-md-links`, and `pnpm constraints`. Record every command and exit code in the handoff.
- [ ] Inspect `git diff --check`, `git status --short`, and the complete branch diff; confirm no `packages/` or `apps/` changes, no credentials, and no generated build output.
- [ ] Commit with `git add business-agent snapshots/session/business-a2a-call .agents/notes/implemented/feature/2026-09-20-a2a-bridge.* pnpm-lock.yaml && git commit -m "feat(business-agent): ship A2A bridge"`.

## Completion Gate

The work is complete only when an official A2A v1.0 client passes discovery, sync, streaming, lookup, and cancellation against the real Business Agent composition; a second local Business Agent is called with only its Agent Card URL and message; restart recovery and all five Review Focus tests pass; focused builds, types, lint, docs, notes, snapshot replay, and constraints pass; and the final branch diff remains entirely within `business-agent/`, `snapshots/session/business-a2a-call/`, `.agents/notes/`, and `pnpm-lock.yaml`.
