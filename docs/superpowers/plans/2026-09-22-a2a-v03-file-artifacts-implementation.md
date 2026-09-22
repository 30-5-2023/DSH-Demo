# A2A v0.3 File Artifacts Implementation Plan

English | [中文](2026-09-22-a2a-v03-file-artifacts-implementation.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact-byte file input and output interoperability with Python `a2a-sdk==0.3.2`, using inline bytes for small files and durable bridge-hosted URLs for large files.

**Architecture:** A focused file-transfer service validates and snapshots every file through DSH attachments, while a separate durable link service owns opaque download capabilities. The executor stages inbound files through Session file uploads and opens a Task-scoped publication window; model tools publish local files into that window, and the outbound client uses the same transfer service to send and materialize files.

**Tech Stack:** TypeScript, Cordis, Node.js streams and HTTP, Express 5.2.1, `@a2a-js/sdk` 1.2.0 legacy v0.3 adapter, DSH attachments and file uploads, storage domains, Node test runner, PowerShell, Python `a2a-sdk==0.3.2`, httpx, Starlette/Uvicorn.

**Spec:** [A2A v0.3 File Artifact Design](../specs/2026-09-22-a2a-v03-file-artifacts-design.md)

## Global Constraints

- Keep every product change under `business-agent/`; consume existing services without modifying `packages/` or `apps/`.
- Accept A2A v0.3 files exactly as Python `a2a-sdk==0.3.2` emits them; do not claim v1.0 file acceptance in this delivery.
- Preserve existing text, data, v0.3, and v1.0 behavior and tests.
- Use `FileWithBytes` at or below `inlineFileMaxBytes` and `FileWithUri` above it; defaults are 1 MiB, 256 MiB maximum file size, and 24-hour link retention.
- Stream filesystem, HTTP, and attachment transfers with cancellation and measured byte limits; never collect a large URI or local file solely to convert it to base64.
- Store canonical bytes only through `ctx.attachments`; stage inbound Session files through `ctx.fileUploads` and expose local materializations only through `fileHostPath`.
- Resolve local paths from the calling Session workspace plus configured absolute roots, reject root escape and escaping symbolic links, and detect changes during reads.
- Allow inbound URI origins only when explicitly listed; allow outbound result URIs from the supplied Agent Card origin plus configured origins; revalidate every redirect and reject HTTPS downgrade.
- Host download URLs only on the dedicated A2A listener, derive them from `publicBaseUrl`, and authorize them with random opaque tokens until expiry.
- Do not add user authentication for the research deployment; do not expose the download route on the shared DSH Web listener.
- Use Cordis effects and awaited, idempotent cleanup. Task completion must not publish a URI whose durable link record is missing.
- Write a failing focused test before each implementation slice, observe the specified failure, add the smallest code that passes, and commit that slice.

## Review Focus

1. A v0.3 body containing non-canonical base64 may be accepted by the SDK's `Buffer.from`; the raw JSON middleware must reject it before compatibility conversion.
2. A permitted URI that redirects to an unlisted origin, HTTPS downgrade, or an endless or oversized stream must stop without publishing a partial Session prompt or local result.
3. A local path whose symbolic link escapes an allowed root or whose inode, size, or timestamps change during streaming must fail even when the initial lexical path looked safe.
4. Concurrent A2A Tasks must not publish into one another's Session or collect files after their own publication window closes.
5. A hosted file must survive bridge restart until expiry, return 410 after expiry, return 404 for an unknown token, and release its attachment reader when the client disconnects.

## File Map

- Modify `business-agent/plugins/a2a-bridge/package.json` for attachment and file-upload service dependencies.
- Modify `src/types.ts` and `src/config.ts` for file settings, branded tokens, transfer records, result fields, failures, and runtime dependencies.
- Create `src/file-transfer.ts` for filename/media validation, bounded streams, URI fetching, local snapshots, Part construction, and local materialization.
- Create `src/file-links.ts` for a new version-1 `a2a_bridge_file_links` metadata domain and expiring capability issuance.
- Create `src/publication.ts` for Task-scoped publication windows and the `publish_a2a_file` tool.
- Modify `src/conversion.ts` and `src/executor.ts` for ordered inbound file admission and completed Artifact assembly.
- Modify `src/http-app.ts` and `src/server.ts` for canonical v0.3 bytes validation and the dedicated download route.
- Modify `src/client.ts` and `src/tool.ts` for outbound local files and remote result materialization.
- Modify `src/index.ts` for service injection, composition, tool registration, startup cleanup, and exports.
- Extend focused tests in `test/config-card.test.mjs`, `store.test.mjs`, `conversion-safe-fetch.test.mjs`, `execution.test.mjs`, `server.test.mjs`, `client-tool.test.mjs`, and `plugin-lifecycle.test.mjs`; create `test/file-transfer.test.mjs` and `test/publication.test.mjs`.
- Extend `business-agent/tests/fixtures/a2a-python-v032-peer.py`, `python-v032-interop.test.mjs`, and `verify-a2a-python-v032.ps1` for exact-version file cases.
- Modify the Bundle config/test, plugin and Business Agent README pairs, model-visible snapshots, and the existing A2A Agent Note pair and pairing records.

## Task 1: Add File Configuration and Runtime Contracts

**Files:** Modify `business-agent/plugins/a2a-bridge/package.json`, `src/types.ts`, `src/config.ts`, `src/index.ts`, and `test/config-card.test.mjs`.

**Interfaces:** Produce resolved numeric limits and URL/root lists on `ResolvedA2AConfigCore`, `A2AOutboundFileInput`, `A2AMaterializedFile`, the extended call input/result, and required Cordis injections for `attachments` and `fileUploads`.

- [ ] **Step 1: Write failing configuration and schema tests.** Assert defaults `inlineFileMaxBytes=1_048_576`, `maxFileBytes=268_435_456`, `fileRetentionMs=86_400_000`, `maxRequestBytes=2_097_152`, empty origin/root lists, and `application/octet-stream` in both Card mode lists; reject an inline limit above the maximum, a body limit smaller than `4 * ceil(inline / 3) + 65_536`, non-origin URLs, non-absolute roots, and retention outside 1 minute through 30 days.
- [ ] **Step 2: Run the focused test and observe the missing fields.** Run `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/config-card.test.mjs`; expect assertions for the new resolved fields and Card mode to fail.
- [ ] **Step 3: Add the exact public and resolved types.** Define these fields and preserve the existing names:

```ts
export interface A2AOutboundFileInput { readonly path: string; readonly name?: string; readonly mime_type?: string }
export interface A2AMaterializedFile { readonly path: string; readonly name: string; readonly mime_type: string; readonly bytes: number; readonly artifact_id: string }
export interface CallA2AAgentInput { readonly files?: readonly A2AOutboundFileInput[] /* existing fields remain */ }
export interface CallA2AAgentResult { readonly files?: readonly A2AMaterializedFile[] /* existing fields remain */ }
```

- [ ] **Step 4: Resolve and validate deployment values.** Add Schemastery fields and explicit `resolveFileOrigins()` and `resolveAllowedRoots()` helpers; canonicalize origins with `new URL(value).origin`, reject credentials/query/fragment/path, resolve roots to absolute paths without requiring them to exist at startup, and enforce the base64 body-budget formula.
- [ ] **Step 5: Add package services and fail-loud injection.** Add peer/dev dependencies on `@deepseek-ai/dsh-attachment` and `@deepseek-ai/dsh-client-file-upload`, import their Cordis augmentations, and change `inject` to `['webServer', 'sessionController', 'storageDomain', 'tools', 'attachments', 'fileUploads']`.
- [ ] **Step 6: Run focused tests and build.** Repeat Step 2; expect every old and new config/Card assertion to pass.
- [ ] **Step 7: Commit the contract slice.** Run `git add business-agent/plugins/a2a-bridge/{package.json,src/types.ts,src/config.ts,src/index.ts,test/config-card.test.mjs} pnpm-lock.yaml && git commit -m "feat(business-agent): configure A2A file transfer"`.

## Task 2: Build Bounded File Transfer Primitives

**Files:** Create `business-agent/plugins/a2a-bridge/src/file-transfer.ts` and `test/file-transfer.test.mjs`; modify `src/types.ts` and `src/index.ts` exports.

**Interfaces:** Produce `A2AFileTransfer.snapshotLocal`, `uploadInboundPart`, `materializePart`, and pure `safeFileName`, `mediaTypeOrDefault`, and `boundedBytes` helpers.

```ts
export interface StoredA2AFile { readonly ref: FileAttachmentRef; readonly mediaType: string }
export class A2AFileTransfer {
  snapshotLocal(input: A2AOutboundFileInput, workspaceRoot: string, signal: AbortSignal): Promise<StoredA2AFile>
  uploadInboundPart(part: Part, sessionId: SessionId, allowedOrigin: (url: URL) => boolean, signal: AbortSignal): Promise<PromptContentPart>
  materializePart(part: Part, allowedOrigin: (url: URL) => boolean, signal: AbortSignal): Promise<StoredA2AFile & { readonly path: string }>
}
```

- [ ] **Step 1: Write failing pure-policy tests.** Cover safe leaf names, missing MIME defaulting to `application/octet-stream`, invalid MIME rejection, measured byte overflow on a lying `Content-Length`, cancellation, HTTP credentials/fragments, unlisted redirect origin, redirect limit, and HTTPS downgrade.
- [ ] **Step 2: Write the Review Focus local-path tests.** In a temporary workspace, accept a regular relative file, reject `..` escape and an escaping symlink, accept a symlink whose real target stays inside the root, and mutate a file after the first chunk so the snapshot rejects instead of returning a reference.
- [ ] **Step 3: Run the new test and observe the missing module.** Run `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/file-transfer.test.mjs`; expect module/export failures.
- [ ] **Step 4: Implement bounded streams and URI policy.** Count each yielded chunk before forwarding it, cancel the response body on overflow, apply the origin predicate before the first request and every redirect, set a deadline from the existing fetch policy, and map failures to distinct `A2ABridgeErrorCode` members.
- [ ] **Step 5: Implement stable local snapshots.** Resolve the workspace and allowed roots with `realpath`, open the target once, require a regular file, stream from that handle into `attachments.saveFileStream`, compare `dev`, `ino`, `size`, `mtimeMs`, and `ctimeMs` from pre/post handle stats, and close the handle in `finally`.
- [ ] **Step 6: Implement Session uploads and local projections.** For raw Parts, stream the Buffer through `fileUploads.uploadStream`; for URL Parts, stream the bounded HTTP body through the same API. For remote outputs, save through attachments and require `attachments.fileHostPath(ref)` to return an absolute path or throw `A2A_ATTACHMENT_PATH_UNAVAILABLE`.
- [ ] **Step 7: Run the new test and the existing conversion/fetch regression test.** Run the Step 3 command followed by `node --test business-agent/plugins/a2a-bridge/test/conversion-safe-fetch.test.mjs`; expect both suites to pass.
- [ ] **Step 8: Commit the transfer slice.** Run `git add business-agent/plugins/a2a-bridge/src/{file-transfer,types,index}.ts business-agent/plugins/a2a-bridge/test/{file-transfer,conversion-safe-fetch}.test.mjs && git commit -m "feat(business-agent): stream A2A files safely"`.

## Task 3: Persist Expiring Hosted File Links

**Files:** Create `business-agent/plugins/a2a-bridge/src/file-links.ts`; modify `src/types.ts`, `src/index.ts`, `test/store.test.mjs`, and `test/plugin-lifecycle.test.mjs`.

**Interfaces:** Produce a separate version-1 metadata domain so the existing `a2a_bridge` task domain and deployed records do not change.

```ts
export type A2AFileToken = Branded<'A2AFileToken'>
export interface A2AFileLinkRecord { readonly token: A2AFileToken; readonly taskId: A2ATaskId; readonly ref: FileAttachmentRef; readonly mediaType: string; readonly createdAt: string; readonly expiresAt: string }
export interface A2AFileLinkRepository { put(record: A2AFileLinkRecord): Promise<void>; get(token: A2AFileToken): Promise<A2AFileLinkRecord | undefined>; delete(token: A2AFileToken): Promise<void>; reapExpired(now: string): Promise<number>; close(): Promise<void> }
export class A2AFileLinks { issue(file: StoredA2AFile, taskId: A2ATaskId): Promise<URL>; resolve(token: string): Promise<{ readonly kind: 'found'; readonly record: A2AFileLinkRecord } | { readonly kind: 'expired' } | { readonly kind: 'missing' }> }
```

- [ ] **Step 1: Write failing persistence tests.** Open JSON-backed storage, issue two links for identical attachment bytes, assert distinct 256-bit base64url tokens, close/reopen, resolve both records, advance the injected clock past expiry, assert `expired`, and assert opportunistic reaping deletes only expired records.
- [ ] **Step 2: Write lifecycle failure tests.** Make link persistence reject and assert no URL is returned; make repository close reject during partial startup and assert the original startup failure plus cleanup failure appear in one `AggregateError`.
- [ ] **Step 3: Run focused tests and observe missing exports.** Run `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/store.test.mjs business-agent/plugins/a2a-bridge/test/plugin-lifecycle.test.mjs`; expect file-link symbols to be absent.
- [ ] **Step 4: Define the independent metadata domain.** Use `defineDomain({ name: 'a2a_bridge_file_links', version: 1, tables: { links: domainTable(schema) } })`; validate token, Task id, attachment id/name/bytes, media type, and ISO timestamps with zod.
- [ ] **Step 5: Implement issuance and expiry.** Generate `randomBytes(32).toString('base64url')`, persist before returning, form `<route>/files/<token>` from `publicBaseUrl`, return 410 state while deleting an expired record, and reap expired entries at startup and during issuance.
- [ ] **Step 6: Compose and close both repositories.** Open task and link repositories before publishing the listener; include the link repository in partial-startup and normal cleanup without changing the existing task domain version.
- [ ] **Step 7: Run focused tests.** Repeat Step 3; expect restart, expiry, uniqueness, and lifecycle cases to pass.
- [ ] **Step 8: Commit the persistence slice.** Run `git add business-agent/plugins/a2a-bridge/src/{file-links,types,index}.ts business-agent/plugins/a2a-bridge/test/{store,plugin-lifecycle}.test.mjs && git commit -m "feat(business-agent): persist A2A file links"`.

## Task 4: Admit Inbound v0.3 Files into Sessions

**Files:** Modify `src/conversion.ts`, `src/executor.ts`, `src/http-app.ts`, `src/types.ts`, `test/conversion-safe-fetch.test.mjs`, `test/execution.test.mjs`, and `test/server.test.mjs`.

**Interfaces:** Change `a2aMessageToPrompt` to asynchronous admission with `sessionId`, `A2AFileTransfer`, an origin predicate, and `AbortSignal`; return the same ordered `UserContent` and requested output mode.

- [ ] **Step 1: Write failing conversion tests.** Pass `[TextPart, raw Part, DataPart, URL Part]`, assert prompt order `[text, file receipt, labeled data text, file receipt]`, exact filenames and MIME values, and `A2A_EMPTY_MESSAGE` only when there is no non-empty text, data, or file.
- [ ] **Step 2: Write failing executor atomicity tests.** Make the second of two files exceed `maxFileBytes`; assert no `sessionController.prompt` call occurs, the Task ends failed with `A2A_FILE_TOO_LARGE`, and cancellation aborts the active upload/fetch.
- [ ] **Step 3: Write the canonical-base64 server test.** POST a v0.3 `message/send` whose `file.bytes` decodes under `Buffer.from` but is not canonical; expect JSON-RPC invalid params and zero executor calls, then send canonical empty and non-empty byte files and expect dispatch.
- [ ] **Step 4: Run focused tests and observe unsupported-Part failures.** Build and run the three test files; expect raw/URL Parts to fail and malformed base64 to reach the SDK.
- [ ] **Step 5: Add raw JSON v0.3 file validation.** After `express.json` and before `jsonRpcHandler`, inspect only v0.3 `kind: 'file'` Parts, require exactly one of `bytes` or `uri`, and require `Buffer.from(bytes, 'base64').toString('base64') === bytes`; leave all other protocol validation to the SDK.
- [ ] **Step 6: Reorder executor admission.** Preserve unknown-context rejection before I/O, create or restore the Session, call async conversion with the exact request signal, and invoke `sessionController.prompt` only after every Part and upload succeeds.
- [ ] **Step 7: Run focused tests and existing text/data regressions.** Repeat Step 4; expect ordered mixed content, canonical validation, atomic prompt behavior, and old text/JSON cases to pass.
- [ ] **Step 8: Commit inbound admission.** Run `git add business-agent/plugins/a2a-bridge/src/{conversion,executor,http-app,types}.ts business-agent/plugins/a2a-bridge/test/{conversion-safe-fetch,execution,server}.test.mjs && git commit -m "feat(business-agent): admit A2A v0.3 file inputs"`.

## Task 5: Publish Task-Scoped Agent Output Files

**Files:** Create `src/publication.ts` and `test/publication.test.mjs`; modify `src/executor.ts`, `src/tool.ts`, `src/types.ts`, `src/index.ts`, `test/execution.test.mjs`, and `test/client-tool.test.mjs`.

**Interfaces:** Produce one publication registry and one tool whose successful value never contains file bytes or capability tokens.

```ts
export interface PublishedA2AFile extends StoredA2AFile { readonly name: string }
export interface A2APublicationWindow extends Disposable { files(): readonly PublishedA2AFile[] }
export class A2AFilePublications { open(taskId: A2ATaskId, sessionId: SessionId): A2APublicationWindow; publish(sessionId: SessionId, file: PublishedA2AFile): void }
export function createPublishA2AFileTool(publications: A2AFilePublications, transfer: A2AFileTransfer): ToolDefinition
```

- [ ] **Step 1: Write failing tool tests.** Assert `publish_a2a_file` requires `exec.agent`, requires an active window for that Session, resolves its path from `exec.agent.session.header.cwd`, snapshots immediately, returns only `{ name, mime_type, bytes, attachment_id }`, and rejects calls after close.
- [ ] **Step 2: Write Review Focus isolation tests.** Open windows for two Sessions and Tasks, publish concurrently, assert each window sees only its own ordered files, reject a second window for the same Session, and assert cancel/failure closes the window without attaching files to the Task.
- [ ] **Step 3: Write Artifact threshold tests.** Publish one file at exactly `inlineFileMaxBytes` and one byte above it; assert completed Artifact Parts are text then raw then URL, link issuance precedes terminal Task persistence, and a link write failure makes the Task fail.
- [ ] **Step 4: Run focused tests and observe missing tool/registry.** Build and run `publication.test.mjs`, `execution.test.mjs`, and `client-tool.test.mjs`; expect missing export and tool schema failures.
- [ ] **Step 5: Implement the registry and tool.** Key active windows by branded Session id, close them in executor `finally`, call `snapshotLocal` before `publish`, register the tool beside `call_a2a_agent`, and make tool presentation show the safe filename rather than the source path.
- [ ] **Step 6: Assemble final Artifacts.** Add `A2AFileTransfer.toPart(file, taskId)`; collect at most 1 MiB for raw Parts, issue durable URLs for larger refs, append Parts to the existing `result` Artifact after text/data, persist the Artifact-bearing Task, publish one final replacement update, then settle completed.
- [ ] **Step 7: Run focused tests.** Repeat Step 4; expect tool scope, isolation, thresholds, link-failure settlement, and existing output behavior to pass.
- [ ] **Step 8: Commit output publication.** Run `git add business-agent/plugins/a2a-bridge/src/{publication,executor,tool,types,index}.ts business-agent/plugins/a2a-bridge/test/{publication,execution,client-tool}.test.mjs && git commit -m "feat(business-agent): publish A2A file artifacts"`.

## Task 6: Serve Large Files from the Dedicated Listener

**Files:** Modify `src/http-app.ts`, `src/server.ts`, `src/types.ts`, `test/server.test.mjs`, and `test/plugin-lifecycle.test.mjs`.

**Interfaces:** Add an optional dedicated-only `A2AFileDownloadHandler` dependency to the HTTP application; shared mode passes no handler and therefore owns no download route.

```ts
export interface A2AFileDownloadHandler { handle(token: string, method: 'GET' | 'HEAD', signal: AbortSignal): Promise<{ readonly status: 200; readonly record: A2AFileLinkRecord; readonly body?: AsyncIterable<Uint8Array> } | { readonly status: 404 | 410 }> }
```

- [ ] **Step 1: Write failing route tests.** Issue a link, call `HEAD` and `GET`, assert exact `Content-Type`, `Content-Length`, safe UTF-8 `Content-Disposition`, `nosniff`, and exact streamed bytes; assert POST returns 405, Range returns 416, unknown returns 404, and expired returns 410.
- [ ] **Step 2: Write listener-separation and disconnect tests.** Assert the shared Web listener returns 404 for the file URL, the dedicated listener succeeds, and aborting a client mid-download aborts the `readFileStream` signal and lets `server.close()` settle.
- [ ] **Step 3: Run server tests and observe 404.** Build and run `server.test.mjs` plus `plugin-lifecycle.test.mjs`; expect every download request to miss.
- [ ] **Step 4: Implement the dedicated route.** Mount `GET|HEAD ${config.route}/files/:token` only when `config.listener` and the download handler are present, validate the base64url token before repository lookup, set headers before streaming, use `Readable.from(iterable).pipe(response)`, and destroy the reader on request/response close.
- [ ] **Step 5: Preserve quiescent shutdown.** Keep downloads in the existing active-response set, stop admission before closing the HTTP server, and await every admitted HEAD/GET response before closing links and attachments dependencies.
- [ ] **Step 6: Run focused tests.** Repeat Step 3; expect routing, status, headers, streaming, disconnect, separation, and shutdown cases to pass.
- [ ] **Step 7: Commit the download endpoint.** Run `git add business-agent/plugins/a2a-bridge/src/{http-app,server,types}.ts business-agent/plugins/a2a-bridge/test/{server,plugin-lifecycle}.test.mjs && git commit -m "feat(business-agent): serve A2A file downloads"`.

## Task 7: Send Local Files and Materialize Remote Outputs

**Files:** Modify `src/client.ts`, `src/tool.ts`, `src/types.ts`, `test/client-tool.test.mjs`, and `test/file-transfer.test.mjs`.

**Interfaces:** Extend `A2AAgentClient.call(input, signal, workspaceRoot?)`; existing callers without `files` remain source-compatible. The tool passes its Session cwd when files are present.

- [ ] **Step 1: Extend the remote fixture.** Record incoming Part order and return text, raw, and URL Parts across replacement and append Artifact updates; make the URL response stream configurable for success, redirect, oversize, and disconnect.
- [ ] **Step 2: Write failing outbound-input tests.** Call with a text message plus two local files around the threshold, assert text/raw/URL order, filename and MIME preservation, and assert the large URL downloads exact bytes from the caller's dedicated endpoint.
- [ ] **Step 3: Write failing output-materialization tests.** Assert `result.output` keeps text/JSON, `result.files` keeps final Artifact order and returns absolute `path`, `name`, `mime_type`, `bytes`, and `artifact_id`; read each path and compare SHA-256. Assert an unsupported Part fails rather than disappearing.
- [ ] **Step 4: Add Review Focus URI failures.** Return a same-origin URI redirected to an unlisted origin, an oversized stream, and a canceled stream; assert stable failures, no `files` result, and no readable partial path.
- [ ] **Step 5: Run the focused client test and observe absent fields.** Build and run `client-tool.test.mjs` plus `file-transfer.test.mjs`; expect tool schema, outgoing Parts, and materialization assertions to fail.
- [ ] **Step 6: Prepare outgoing Parts.** Snapshot every `files` entry against `workspaceRoot`, append `toPart()` results after the existing message Part, require a workspace when files are supplied, and preserve existing transport selection, timeout, context, accepted output mode, and cancellation.
- [ ] **Step 7: Collect outputs asynchronously.** Replace `outputFromParts` with an async collector that separates text/data from raw/URL, uses the Agent Card origin plus configured origins for URL materialization, assigns the owning Artifact id, and rejects unknown content cases through `assertNever`.
- [ ] **Step 8: Extend the model-visible schema and rendering.** Add `files` input and result arrays, keep bytes out of rendering, pass `exec.agent.session.header.cwd`, and preserve the six existing fields unchanged.
- [ ] **Step 9: Run focused tests.** Repeat Step 5; expect v0.3 and v1 regressions, threshold Parts, path materialization, URI failures, and tool schema to pass.
- [ ] **Step 10: Commit outbound files.** Run `git add business-agent/plugins/a2a-bridge/src/{client,tool,types}.ts business-agent/plugins/a2a-bridge/test/{client-tool,file-transfer}.test.mjs && git commit -m "feat(business-agent): exchange A2A call files"`.

## Task 8: Prove Exact Python 0.3.2 File Interoperability

**Files:** Modify `business-agent/tests/fixtures/a2a-python-v032-peer.py`, `business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs`, and `business-agent/verify-a2a-python-v032.ps1`.

**Interfaces:** Keep `client BASE_URL` and `server` modes; add a temporary-directory argument and emit compact JSON verdicts containing SHA-256, filenames, MIME types, Part order, and downloaded URI bytes.

- [ ] **Step 1: Extend Python imports and helpers.** Use package-native `FilePart`, `FileWithBytes`, and `FileWithUri`; implement streaming URI download with httpx and SHA-256 without decoding a large file into the JSON verdict.
- [ ] **Step 2: Add Python-to-DSH cases.** Send one mixed text/data/bytes/URI message whose two files have distinct bytes and metadata, then invoke a command that makes the Business Agent publish one small and one large file; verify Task Artifact file classes and download the URI case.
- [ ] **Step 3: Add DSH-to-Python cases.** Make the Python executor inspect input FileParts, download URI input, verify hashes, and return one `FileWithBytes` and one `FileWithUri`; have the Node test call with two local files and verify every materialized result path.
- [ ] **Step 4: Run the normal JavaScript suite without Python.** Run `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test`; expect the exact-version test to self-skip and every other test to pass.
- [ ] **Step 5: Run the pinned environment and observe failures before completing fixtures.** Run `powershell -NoProfile -File business-agent/verify-a2a-python-v032.ps1`; expect missing file verdict fields, then finish the fixture wiring until the same command passes with `a2a-sdk 0.3.2`.
- [ ] **Step 6: Add byte-boundary assertions.** Use exactly 1 MiB and 1 MiB plus one byte payloads, assert bytes versus URI classes, and verify exact SHA-256 values in both directions.
- [ ] **Step 7: Commit exact-version interoperability.** Run `git add business-agent/tests/fixtures/a2a-python-v032-peer.py business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs business-agent/verify-a2a-python-v032.ps1 && git commit -m "test(business-agent): prove A2A 0.3 file interop"`.

## Task 9: Wire Deployment Defaults, Documentation, Snapshots, and Final Gates

**Files:** Modify `business-agent/bundle/cordis.patch.yml`, `business-agent/bundle/test/config.mjs`, `business-agent/plugins/a2a-bridge/README.md`, `.zh.md`, and pairing record; modify `business-agent/README.md`, `.zh.md`, and pairing record; update relevant migration docs, snapshots, and `.agents/notes/implemented/feature/2026-09-20-a2a-bridge.md`, `.zh.md`, and pairing records.

**Interfaces:** Bundle defaults match Task 1 and allow environment overrides for origins, roots, thresholds, maximum size, and retention without checking a machine IP into the image.

- [ ] **Step 1: Make Bundle tests expect file policy.** Assert numeric defaults, `application/octet-stream` modes, empty arrays, and environment parsing for comma-separated exact origins and absolute roots; reject malformed values before profile startup.
- [ ] **Step 2: Run the Bundle test and observe missing config.** Run `pnpm --filter @deepseek-ai/dsh-business-agent test`; expect file-policy assertions to fail.
- [ ] **Step 3: Add runtime-owned Bundle values.** Set `maxRequestBytes: 2097152`, the three file defaults, and `!!js` expressions for allowed origins and roots; keep `A2A_PUBLIC_BASE_URL` as the only advertised address.
- [ ] **Step 4: Update bilingual operating documentation.** Document Python 0.3.2 types, local-path meaning, small/large thresholds, URI allowlist, download lifetime, Docker/Kubernetes address injection, `publish_a2a_file`, `call_a2a_agent.files`, materialized result paths, no-auth limits, and copy/deploy requirements; regenerate every touched pairing record.
- [ ] **Step 5: Update the existing Agent Note and snapshots.** Replace the text/JSON-only statement with the shipped file decisions, record the separate link metadata domain and attachment ownership, update the model-visible tool snapshot for both tools, and re-record only the affected snapshot case.
- [ ] **Step 6: Run focused package and deployment checks.** Run `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build`, its package test, the Bundle test, and `powershell -NoProfile -File business-agent/verify-a2a-python-v032.ps1`; expect zero failures and the exact Python version verdict.
- [ ] **Step 7: Run repository gates selected by `dsh-pre-push-checks`.** At minimum run `pnpm run typecheck`, `pnpm run lint`, `pnpm run test:docs`, `pnpm run doc-sync`, the affected recorded snapshot command, and `git diff --cached --check`; report any host-only skip or failure exactly.
- [ ] **Step 8: Request whole-branch review.** Invoke `superpowers:requesting-code-review`, address accepted findings with focused red-green tests, rerun only the checks covering the changed findings, and keep unrelated worktree changes untouched.
- [ ] **Step 9: Commit the deployment and documentation slice.** Stage only the listed Business Agent, snapshot, and Agent Note files and run `git commit -m "docs(business-agent): document A2A file artifacts"`.
- [ ] **Step 10: Finish the branch deliberately.** Invoke `superpowers:finishing-a-development-branch`, present verified integration options, and do not merge or push until the user selects one.
