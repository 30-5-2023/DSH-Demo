# A2A v0.3 File Artifact Design

English | [中文](2026-09-22-a2a-v03-file-artifacts-design.zh.md)

Design status: approved for implementation planning on 2026-09-22.

## Summary

The Business Agent accepts and returns files through the A2A v0.3 wire format used by Python `a2a-sdk==0.3.2`. Small files travel inline as `FileWithBytes`; large files travel by bridge-hosted `FileWithUri` URLs. Every admitted or published file is first snapshotted into the existing DSH attachment service, so Session inputs, remote outputs, retries, and downloads refer to stable bytes instead of a mutable source path.

This design extends the existing [A2A Bridge design](2026-09-20-a2a-bridge-design.md) and [A2A v0.3 compatibility and LAN listener design](2026-09-21-a2a-v03-lan-compatibility-design.md). It supersedes those documents only where file Parts, file publication, file download routes, configuration, and related tests differ.

## Table of Contents

- [Goals](#goals)
- [Constraints](#constraints)
- [Selected approach](#selected-approach)
- [A2A v0.3 mapping](#a2a-v03-mapping)
- [Inbound files](#inbound-files)
- [Publishing Agent output files](#publishing-agent-output-files)
- [Outbound calls](#outbound-calls)
- [Download endpoint](#download-endpoint)
- [Persistence and lifecycle](#persistence-and-lifecycle)
- [Configuration](#configuration)
- [Failures and security](#failures-and-security)
- [Testing](#testing)
- [Acceptance criteria](#acceptance-criteria)
- [Non-goals](#non-goals)
- [References](#references)

<a id="goals"></a>
## Goals

- A Python client using `a2a-sdk==0.3.2` can send `FileWithBytes` and `FileWithUri` Parts to the Business Agent together with text and data Parts.
- The Business Agent can publish generated local files as A2A v0.3 output Artifacts without scanning its workspace or interpreting file paths in natural-language responses.
- `call_a2a_agent` can send local files to a Python `a2a-sdk==0.3.2` Agent and materialize file outputs returned by that Agent.
- Small transfers remain self-contained, while large transfers stream through URLs instead of expanding whole files into base64 in process memory or model-visible tool output.
- File bytes, filenames, media types, Part ordering, Task ownership, cancellation, and configured size limits remain deterministic across synchronous and streaming calls.

<a id="constraints"></a>
## Constraints

- The implementation remains under `business-agent/` and consumes existing services without modifying `packages/` or `apps/`.
- The acceptance target is A2A v0.3 as implemented by Python `a2a-sdk==0.3.2`; v1.0 file interoperability is not an acceptance requirement for this change.
- Existing text, data, v0.3, and v1.0 behavior remains available. The bridge does not deliberately remove the SDK's current v1.0 compatibility while narrowing new file tests and documentation to v0.3.
- A server cannot read a caller's local filesystem path. Remote callers must transmit bytes or an HTTP(S) URI that the server can fetch.
- The research deployment does not require user authentication, but it must not expose predictable file URLs, arbitrary local paths, unbounded downloads, or unrelated DSH Web routes.
- Files use the existing DSH attachment service as their durable byte store. The bridge does not create a second file repository.

<a id="selected-approach"></a>
## Selected approach

The bridge uses the official `@a2a-js/sdk` v0.3 compatibility conversion for wire types. A v0.3 `FileWithBytes` arrives internally as a raw Part, and a v0.3 `FileWithUri` arrives internally as a URL Part. The inverse conversion emits the corresponding v0.3 FilePart, so the bridge adds admission, storage, publication, and materialization around those core Part variants instead of maintaining a private A2A codec.

Every file crosses one canonical snapshot step. Incoming bytes or fetched URI content, local files selected for an outbound call, and files explicitly published by the served Agent are streamed into `ctx.attachments.saveFileStream`. Later reads use `ctx.attachments.readFileStream`, which verifies the stored length and digest while preserving backpressure and cancellation.

The hybrid transfer rule is based on stored byte count. A file whose byte count is at most `inlineFileMaxBytes` is emitted as `FileWithBytes`; a larger file is emitted as `FileWithUri` backed by the dedicated A2A listener. No branch is selected from filename, media type, caller identity, or model judgment.

Automatic workspace scanning was rejected because it could leak unrelated files and cannot reliably distinguish generated output from temporary state. Returning every file as base64 was rejected because base64 increases payload size and requires whole-payload JSON handling. Returning only local server paths was rejected because remote callers cannot dereference them.

<a id="a2a-v03-mapping"></a>
## A2A v0.3 mapping

| A2A v0.3 value | SDK internal Part | Bridge treatment |
| --- | --- | --- |
| `FilePart(file.bytes, file.name, file.mimeType)` | raw bytes with filename and media type | Validate, snapshot, and admit as a DSH file input or output |
| `FilePart(file.uri, file.name, file.mimeType)` | URL with filename and media type | Fetch under URI policy, snapshot, and admit as a DSH file input or output |
| Bridge inline file | raw bytes with filename and media type | SDK emits v0.3 `FileWithBytes` |
| Bridge hosted file | URL with filename and media type | SDK emits v0.3 `FileWithUri` |

The bridge preserves the order of text, data, and file Parts when constructing Session prompt content and when collecting remote output. A filename is display metadata only and is reduced to a safe leaf name before storage or response headers; it never selects a filesystem destination.

For a v0.3 file, exactly one of bytes or URI must be present. Missing content, conflicting content, malformed base64, an empty or unsafe filename, an invalid media type, or content beyond `maxFileBytes` fails the request with a stable bridge error instead of being dropped.

<a id="inbound-files"></a>
## Inbound files

For `FileWithBytes`, the bridge validates canonical base64 at the protocol boundary, decodes incrementally or through the attachment admission API, enforces `maxFileBytes`, and stores the exact decoded bytes. The configured inline threshold controls bridge emission only; an inbound peer may send a larger inline value when the HTTP request and file limits both allow it.

For inbound `FileWithUri`, the bridge accepts only absolute HTTP(S) URLs without credentials or fragments and requires the source origin to appear in `fileUrlAllowedOrigins`. An empty list therefore disables inbound URI fetching while leaving byte files available. Redirects are bounded, every redirect target is checked again, HTTPS-to-HTTP downgrade is rejected, and response streaming stops as soon as it exceeds `maxFileBytes`.

The bridge uploads the stored file into the target Session through the existing file-upload service and prompts the Session with a file content block in the original Part position. Generic files remain generic file inputs even when their media type starts with `image/`; this change guarantees exact A2A file semantics and does not add vision-specific image normalization.

Admission is all-or-nothing for one message. The bridge prepares every file and validates every Part before prompting the Session; a failed member does not publish a partial prompt. Cancellation aborts URI fetches, attachment writes, and Session upload work.

<a id="publishing-agent-output-files"></a>
## Publishing Agent output files

The plugin registers a model-visible `publish_a2a_file` tool with `path`, optional `name`, and optional `media_type`. The tool is an internal DSH capability, not an A2A protocol extension. It succeeds only while the current Session turn belongs to an active inbound A2A Task and associates the resulting attachment reference with that Task.

The tool resolves relative paths against the current Session workspace. Absolute paths are accepted only inside the Session workspace or a configured `publishFileAllowedRoots` entry. The resolved target must be a regular file, must not traverse through an escaping symbolic link, and must remain unchanged between the pre-read and post-read file identity checks.

Publication snapshots the file immediately with `saveFileStream`; later edits or deletion of the source path cannot change the Artifact. Repeated publication creates ordered file entries for the current Task. Concurrent Tasks and Sessions cannot observe or publish each other's pending entries.

At successful Task completion, the executor includes published files in output Artifacts after any existing text or data output produced for that Task. Files at or below `inlineFileMaxBytes` become raw Parts; larger files receive hosted URLs and become URL Parts. A failed, canceled, rejected, or timed-out Task does not expose unpublished or partially stored file output.

<a id="outbound-calls"></a>
## Outbound calls

`call_a2a_agent` gains an optional `files` array. Each entry contains `path` and optional `name` and `mime_type`; the existing `message`, `context_id`, `stream`, `accepted_output_mode`, and `timeout_ms` fields keep their current behavior.

Local outbound paths follow the same allowed-root, regular-file, symbolic-link, size, and stable-read checks as `publish_a2a_file`. Each accepted file is snapshotted before network dispatch. The outgoing message preserves the existing text or data Part first and appends file Parts in the declared array order.

Small outbound files use raw Parts and therefore v0.3 `FileWithBytes`. Large outbound files use URLs served by the calling bridge and therefore v0.3 `FileWithUri`. Large-file calls require a dedicated listener and a reachable `publicBaseUrl`; configuration or call preparation fails explicitly when the bridge cannot create a remotely reachable URI.

The result adds an ordered `files` array without embedding file bytes. For every remote raw or URL output Part, the bridge enforces the same size policy; a remote URL may use the resolved Agent Card origin or an origin in `fileUrlAllowedOrigins`. The bridge snapshots the bytes into DSH attachments, materializes a read-only local file projection, and returns `path`, `name`, `mime_type`, `bytes`, and `artifact_id`. Text and JSON remain in `output`; unsupported Part variants fail instead of disappearing silently.

Remote outputs are collected from the final Message or Task Artifacts for synchronous calls and from the assembled Artifact stream for streaming calls. Artifact append and replacement semantics remain transport-owned, and a file is materialized only from the final assembled Part sequence.

<a id="download-endpoint"></a>
## Download endpoint

The dedicated A2A listener adds `GET` and `HEAD` at `<route>/files/<token>`, which defaults to `/a2a/files/<token>`. The route is absent from the shared DSH Web listener. `GET` streams verified attachment chunks with backpressure; `HEAD` returns the same metadata without content. Byte-range requests are not supported in this delivery.

`<token>` is a cryptographically random, non-enumerable capability value. Its durable record contains the attachment reference, owning Task id, safe filename, media type, byte count, creation time, and expiry. URLs are formed from `publicBaseUrl`; neither `0.0.0.0` nor a hardcoded machine or container address appears in stored configuration.

Successful responses set `Content-Type`, `Content-Length`, a safe `Content-Disposition`, and `X-Content-Type-Options: nosniff`. An unknown or revoked token returns 404. An expired token returns 410. Other routes remain 404 and never fall through to DSH Web handlers.

The token itself authorizes download during the configured research deployment. It is suitable only for trusted-network evaluation: logs and model output must not print tokens unnecessarily, redirects are not emitted, and a future authenticated deployment requires a separate authorization design.

<a id="persistence-and-lifecycle"></a>
## Persistence and lifecycle

File-link records use the bridge's existing storage domain so a process restart preserves valid downloads until expiry. Attachment bytes remain owned by the attachment service; deleting or expiring a link revokes bridge access but does not directly delete a shared content-addressed attachment.

Task publication records are written before the Task reaches a completed state, so a returned URI never points to missing metadata. If link persistence fails, Task completion fails rather than returning an unusable Artifact. Partial startup and shutdown use the existing bridge lifecycle ordering and close admitted download streams before storage disposal.

Expired records are removed opportunistically at startup and during link creation or access. Cleanup is bounded and idempotent. The attachment provider remains the authority for attachment retention and integrity; `fileRetentionMs` controls only link validity.

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `inlineFileMaxBytes` | 1 MiB | Largest stored file emitted as v0.3 `FileWithBytes` |
| `maxFileBytes` | 256 MiB | Maximum admitted, fetched, published, sent, or materialized file size |
| `fileRetentionMs` | 24 hours | Lifetime of a hosted file capability URL |
| `fileUrlAllowedOrigins` | `[]` | Exact HTTP(S) origins allowed for inbound URI files and additional origins allowed for remote-output URI files |
| `publishFileAllowedRoots` | `[]` | Additional absolute local roots allowed beside the active Session workspace |
| `maxRequestBytes` | 2 MiB | Existing JSON-RPC body limit, raised from 1 MiB so the default inline file plus base64 and JSON overhead fits |

All values are Cordis configuration fields because they vary by deployment. `inlineFileMaxBytes` must be positive and no greater than `maxFileBytes`. The resolver also verifies that `maxRequestBytes` can contain a worst-case inline file after base64 and JSON overhead; an invalid combination fails at plugin load.

`publicBaseUrl` remains the only advertised address. The dedicated listener is required whenever the bridge may emit a hosted URI. The Agent Card input and output modes include `application/octet-stream` in addition to the configured text and JSON modes.

The plugin requires attachment storage and Session file-upload services at load. Missing services or providers without generic file streaming fail loudly before the A2A endpoint becomes available.

<a id="failures-and-security"></a>
## Failures and security

Stable bridge failures distinguish malformed file data, rejected URI, redirect limit, protocol downgrade, fetch timeout, oversized content, unsupported media metadata, local path rejection, unstable local file, missing attachment service, expired link, and remote materialization failure. Protocol handlers map them to version-appropriate A2A failures, while model-visible tools return concise diagnostics without remote response bodies, local storage internals, or tokens.

All network and filesystem transfers are streamed with cancellation and explicit byte accounting. A misleading `Content-Length` never bypasses the measured-byte limit. URI validation runs before each request and redirect, and local path validation runs on the resolved target used for opening the file.

The initial no-auth deployment assumes a trusted intranet. Capability tokens reduce accidental discovery but do not replace authentication, authorization, TLS, egress controls, malware scanning, quotas, or audit policy. Those controls remain required before exposing the listener outside the trusted research network.

<a id="testing"></a>
## Testing

Focused unit tests cover v0.3 raw and URL Part mapping, canonical base64, filename and media-type validation, Part order, inline threshold selection, allowed origins and redirects, stable local-file reads, token generation, expiry, response headers, restart recovery, output collection, concurrency isolation, and every stable failure class.

Integration tests use real attachment and file-upload services to verify exact bytes and SHA-256 digests across inbound Session admission, explicit Task publication, hosted download, outbound snapshotting, and remote-output materialization. Tests stop oversized streams at the first excess chunk and verify cancellation releases readers, fetches, and HTTP responses.

An isolated Python environment pins the actual `a2a-sdk==0.3.2`. Python-to-DSH cases send `FileWithBytes`, `FileWithUri`, and mixed text/data/file messages. DSH-to-Python cases send small inline and large hosted local files. Python then receives published small and large Task Artifacts, downloads the URI case, and verifies bytes, name, MIME type, ordering, Task id, and terminal state.

Existing text and JSON v0.3 tests remain. Existing v1.0 tests remain as regression coverage, but this change does not claim or add v1.0 file acceptance. The implementation updates the package README pair, Business Agent quick start, bundle configuration, model-visible tool snapshots, and an Agent Note in the same change.

<a id="acceptance-criteria"></a>
## Acceptance criteria

- Python `a2a-sdk==0.3.2` sends inline and URI files to the Business Agent, and the Session receives exact stored files in original Part order.
- `publish_a2a_file` returns a small generated file as `FileWithBytes` and a large generated file as a downloadable `FileWithUri` in the completing v0.3 Task.
- `call_a2a_agent` sends small and large local files to a Python 0.3.2 Agent and returns remote file outputs as local materialized paths with metadata, never embedded bytes.
- Every round trip preserves exact bytes, safe filename, media type, Artifact ordering, Task ownership, timeout, and cancellation behavior.
- Hosted URLs survive process restart until expiry, return 410 after expiry, and derive their address from runtime `publicBaseUrl` rather than a hardcoded IP.
- Oversized, malformed, disallowed-origin, path-escaping, symbolic-link-escaping, changed-during-read, expired, and unsupported file cases fail explicitly without partial Session prompts or silently omitted Parts.
- Existing text and JSON A2A v0.3 behavior and existing A2A v1.0 regression tests continue to pass.

<a id="non-goals"></a>
## Non-goals

This change does not add v1.0 file acceptance, direct access to a caller's local path, workspace scanning, resumable or range downloads, public-Internet hardening, antivirus scanning, content transformation, object-store URLs, file previews, or automatic attachment deletion. It does not change the shared DSH Web listener or introduce a second attachment store.

<a id="references"></a>
## References

- [A2A Python SDK 0.3.2 types](https://github.com/a2aproject/a2a-python/blob/v0.3.2/src/a2a/types.py)
- [A2A JavaScript SDK v0.3 compatibility guide](https://github.com/a2aproject/a2a-js/blob/main/docs/compatibility-v0_3.md)
- [DSH attachment service](../../../packages/attachment/attachment/README.md)
- [DSH local attachment provider](../../../packages/attachment/attachment-local/README.md)
