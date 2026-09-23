# A2A v0.3 Compatibility and LAN Listener Implementation Plan

English | [中文](2026-09-21-a2a-v03-lan-compatibility-implementation.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Business Agent interoperable in both directions with Python `a2a-sdk==0.3.2` and expose only its A2A routes through an optional intranet-facing listener.

**Architecture:** The bridge enables the official `@a2a-js/sdk` legacy compatibility adapters while preserving v1.0 internal types and transport preference. A private Express application becomes independent of its host adapter, so the plugin can either register it on the shared loopback Web Server or serve it from a dedicated Node HTTP listener whose advertised URL is injected at runtime.

**Tech Stack:** TypeScript, Cordis, Node HTTP, Express 5.2.1, `@a2a-js/sdk` 1.2.0, Node test runner, PowerShell, Python `a2a-sdk==0.3.2`, httpx, Starlette/Uvicorn.

**Spec:** [A2A v0.3 Compatibility and LAN Listener Design](../specs/2026-09-21-a2a-v03-lan-compatibility-design.md)

## Global Constraints

- Keep every product change under `business-agent/`; do not modify `packages/` or `apps/`.
- Keep A2A v1.0 as the preferred protocol and add v0.3 compatibility without changing the `call_a2a_agent` tool schema.
- Target Python package `a2a-sdk==0.3.2`; advertise its wire family as protocol version `0.3`, not `0.3.2`.
- Keep JSON-RPC as the only binding and support only send, streaming send, task lookup, and cancellation.
- Keep the DSH Web listener on loopback; an intranet listener exposes only the Agent Card and configured A2A JSON-RPC route.
- Permit the research listener to run without Bearer authentication. Preserve token validation and enforcement when `bearerTokenEnv` is configured.
- Never advertise `0.0.0.0`; require an explicit HTTP(S) `publicBaseUrl` when the effective A2A listener binds all interfaces.
- Obtain `publicBaseUrl` from runtime configuration so container and host addresses never enter the image or checked-in deployment value.
- Use Cordis effects and awaited, idempotent cleanup. Listener disposal must stop admission before waiting for active responses.
- Write a failing focused test before each implementation slice, observe the specified failure, add the smallest code that passes, and commit that slice.

## Review Focus

1. A Python 0.3.2 client omits `A2A-Version`; Card discovery must return a legacy-parsable Card instead of a v1-only Card.
2. A v1.0 peer must continue to select native v1 methods after legacy compatibility is enabled; compatibility must not silently downgrade modern traffic.
3. A wildcard listener with a missing or `0.0.0.0` advertised hostname must fail at load instead of returning an unreachable Agent Card URL.
4. A dedicated port conflict or partial startup failure must close all previously created bridge resources and leave no listener behind.
5. Shutdown with an admitted streaming response must stop new connections and wait for that response before the plugin effect settles.

## File Map

- Modify `business-agent/plugins/a2a-bridge/src/types.ts` for listener configuration and resolved endpoint types.
- Modify `business-agent/plugins/a2a-bridge/src/config.ts` for listener-aware validation and optional LAN authentication.
- Modify `business-agent/plugins/a2a-bridge/src/card.ts` for explicit v1.0 and v0.3 JSON-RPC interfaces.
- Create `business-agent/plugins/a2a-bridge/src/http-app.ts` for the private Express application, admission tracking, authentication, and HTTP failures.
- Modify `business-agent/plugins/a2a-bridge/src/server.ts` for shared and dedicated hosting adapters.
- Modify `business-agent/plugins/a2a-bridge/src/index.ts` for asynchronous server startup and failure cleanup.
- Modify `business-agent/plugins/a2a-bridge/src/client.ts` for v0.3-aware Card resolution and JSON-RPC selection.
- Modify `business-agent/plugins/a2a-bridge/test/config-card.test.mjs`, `server.test.mjs`, and `client-tool.test.mjs` for focused compatibility and lifecycle coverage.
- Create `business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs` for optional exact-version interoperability.
- Create `business-agent/tests/fixtures/a2a-python-v032-peer.py` and `a2a-python-v032-requirements.txt` for the real Python peer.
- Create `business-agent/verify-a2a-python-v032.ps1` for reproducible venv setup and the exact-version smoke.
- Modify `business-agent/bundle/cordis.patch.yml` and `business-agent/bundle/test/config.mjs` for runtime listener values.
- Modify `business-agent/start-dev.ps1` for separate Web and A2A startup parameters and URLs.
- Modify the A2A plugin, Bundle, Business Agent, and migration README pairs and their pairing records.
- Modify `.agents/notes/implemented/feature/2026-09-20-a2a-bridge.md`, its Chinese counterpart, and its pairing record so the existing decision owner matches shipped behavior.

## Task 1: Resolve Listener Configuration and Advertise Both Protocol Versions

**Files:** Modify `src/types.ts`, `src/config.ts`, `src/card.ts`, and `test/config-card.test.mjs` in `business-agent/plugins/a2a-bridge/`.

**Interfaces:**

```ts
export interface A2AListenerConfig {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
}

export interface ResolvedA2AConfigCore {
  readonly listener?: A2AListenerConfig
  readonly publicBaseUrl: URL
  readonly route: string
  readonly cardPath: '/.well-known/agent-card.json'
}
```

- [ ] **Step 1: Extend the configuration tests with the dual interface contract.** Assert that `supportedInterfaces.map(({ protocolVersion }) => protocolVersion)` equals `['1.0', '0.3']`, both entries use the same `/a2a` URL and `JSONRPC`, and repeated Card construction never adds a third interface.
- [ ] **Step 2: Add failing listener validation cases.** Cover `listener.host` outside `127.0.0.1 | 0.0.0.0`, ports `0` and `65536`, wildcard binding without `publicBaseUrl`, and `publicBaseUrl: http://0.0.0.0:3082`; also assert that wildcard binding without `bearerTokenEnv` now resolves successfully.
- [ ] **Step 3: Run the focused test and observe the old behavior.** Run `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/config-card.test.mjs`; expect the single-interface assertion and no-token wildcard assertion to fail.
- [ ] **Step 4: Add listener types and Schemastery fields.** Add optional `listener.host` and `listener.port`, validate the closed host set and ports 1 through 65535, and calculate the effective host and port from `listener` when present or `A2ADeployment` when absent.
- [ ] **Step 5: Separate advertised-address and authentication rules.** Require `publicBaseUrl` only when the effective host is `0.0.0.0`, reject an advertised hostname equal to `0.0.0.0`, and remove the wildcard-only requirement for `bearerTokenEnv` while retaining non-empty environment lookup when it is configured.
- [ ] **Step 6: Build explicit v1.0 and v0.3 interfaces.** Use the official helper instead of hand-copying fields:

```ts
declare const rpcUrl: URL
declare function duplicateInterfacesForLegacy(interfaces: readonly unknown[], transports: readonly string[]): readonly unknown[]

const supportedInterfaces = duplicateInterfacesForLegacy([{
  url: rpcUrl.href,
  protocolBinding: 'JSONRPC',
  tenant: '',
  protocolVersion: '1.0',
}], ['JSONRPC'])
```

- [ ] **Step 7: Run the focused test and package build.** Run the command from Step 3; expect every configuration and Card assertion to pass.
- [ ] **Step 8: Commit the configuration slice.** Run `git add business-agent/plugins/a2a-bridge/src/{types,config,card}.ts business-agent/plugins/a2a-bridge/test/config-card.test.mjs && git commit -m "feat(business-agent): advertise A2A v0.3 compatibility"`.

## Task 2: Enable Inbound v0.3 and Add the Dedicated Listener

**Files:** Create `src/http-app.ts`; modify `src/server.ts`, `src/index.ts`, `test/server.test.mjs`, and package exports in `src/index.ts`.

**Interfaces:**

```ts ignore-check
export interface A2AHttpApplication {
  readonly dispatch: import('node:http').RequestListener
  close(): Promise<void>
}

export interface A2AServer {
  readonly cardUrl: URL
  readonly rpcUrl: URL
  close(): Promise<void>
}

export function createA2AHttpApplication(config: ResolvedA2AConfig, handler: A2ARequestHandler): A2AHttpApplication
export async function createA2AServer(ctx: Context, config: ResolvedA2AConfig, handler: A2ARequestHandler): Promise<A2AServer>
```

- [ ] **Step 1: Add a failing legacy Card test.** Fetch the Card without `A2A-Version` and assert the JSON contains v0.3 fields `protocolVersion`, `url`, and `preferredTransport`; fetch again with `A2A-Version: 1.0` and assert the v1 `supportedInterfaces` array remains present.
- [ ] **Step 2: Add failing v0.3 JSON-RPC tests.** POST `message/send`, `message/stream`, `tasks/get`, and `tasks/cancel` bodies that use Python 0.3.2 field names; assert v0.3 task states and Parts, and assert an unsupported legacy method receives the version-appropriate SDK error.
- [ ] **Step 3: Add dedicated-host tests.** Invoke the low-level listener adapter with `127.0.0.1:0`, call the real Express application through its assigned port, assert Card and RPC success, assert an unrelated path returns 404, and assert the shared Web Server still returns 404 for A2A paths in dedicated mode.
- [ ] **Step 4: Add Review Focus lifecycle tests.** Hold a streamed response at an explicit barrier, call `close()`, assert a second connection is rejected, release the barrier, and assert close settles; occupy a port before startup and assert the bind error leaves the shared registrations and active-response set empty.
- [ ] **Step 5: Run the server test and observe failure.** Run `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/server.test.mjs`; expect missing legacy fields, method-not-found for v0.3 methods, and missing dedicated adapter failures.
- [ ] **Step 6: Extract the private HTTP application.** Move method checks, optional Bearer middleware, JSON limit, SDK handlers, safe error middleware, and the active-response set into `http-app.ts`; enable compatibility on both handlers:

```ts
declare const handler: unknown
declare const agentCardHandler: (options: unknown) => unknown
declare const jsonRpcHandler: (options: unknown) => unknown
declare const UserBuilder: { readonly noAuthentication: unknown }

const legacyCompat = { enabled: true } as const
const card = agentCardHandler({ agentCardProvider: handler, legacyCompat })
const rpc = jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication, legacyCompat })
```

- [ ] **Step 7: Implement the two hosting adapters.** Shared mode registers exact paths through `ctx.webServer`. Dedicated mode creates one Node HTTP server, binds `config.listener.host` and `config.listener.port`, exposes no other routes, removes admission before shutdown, awaits `server.close()`, and then awaits `A2AHttpApplication.close()`.
- [ ] **Step 8: Make plugin startup asynchronous and failure-safe.** Await `createA2AServer` in `apply`; on bind or route failure call the existing `closeBridge` path exactly once, then rethrow the original startup error with cleanup failures attached through `AggregateError` only when cleanup also fails.
- [ ] **Step 9: Run the server test and package build.** Repeat Step 5; expect v0.3, v1.0, dedicated listener, bind conflict, and quiescent close cases to pass.
- [ ] **Step 10: Commit the inbound and listener slice.** Run `git add business-agent/plugins/a2a-bridge/src/{http-app,server,index}.ts business-agent/plugins/a2a-bridge/test/server.test.mjs && git commit -m "feat(business-agent): add dedicated A2A listener"`.

## Task 3: Enable Outbound v0.3 Without Downgrading v1.0

**Files:** Modify `src/client.ts` and `test/client-tool.test.mjs`.

**Interfaces:** Keep `A2AAgentClient.call(input, signal)` and the six `call_a2a_agent` inputs unchanged.

- [ ] **Step 1: Extend the remote fixture with a legacy mode.** Serve a dual-interface Card through a compatibility-enabled Card handler, enable compatibility on its JSON-RPC handler, and record received JSON-RPC method names before dispatch.
- [ ] **Step 2: Add a failing v0.3 outbound test.** Call the legacy fixture synchronously and through streaming, continue the returned context, and assert the fixture observed `message/send`, `message/stream`, and `tasks/get` rather than v1 PascalCase names.
- [ ] **Step 3: Add the v1 non-downgrade assertion.** Call the existing v1 fixture and assert it still observes `SendMessage` or `SendStreamingMessage`; run both modes in the same test process so factory state cannot leak between calls.
- [ ] **Step 4: Run the client test and observe failure.** Run `pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build && node --test business-agent/plugins/a2a-bridge/test/client-tool.test.mjs`; expect the legacy Card parser or v0.3 method assertion to fail.
- [ ] **Step 5: Enable compatibility at both outbound decision points.** Configure the existing bounded fetches as follows:

```ts ignore-check
const cardResolver = new DefaultAgentCardResolver({
  fetchImpl: createBoundedFetch({ ...common, signal }),
  legacyCompat: { enabled: true },
})
const transport = new JsonRpcTransportFactory({
  fetchImpl: createStreamingBoundedFetch(common),
  legacyCompat: { enabled: true },
})
```

- [ ] **Step 6: Preserve transport ownership.** Do not add a version field to `CallA2AAgentInput`; allow the normalized Agent Card interface to choose legacy or v1 transport, and retain current cancellation, timeout, size, and safe-failure behavior.
- [ ] **Step 7: Run the focused test and package build.** Repeat Step 4; expect legacy calls, native v1 calls, existing failure safety, and the unchanged tool schema to pass.
- [ ] **Step 8: Commit the outbound slice.** Run `git add business-agent/plugins/a2a-bridge/src/client.ts business-agent/plugins/a2a-bridge/test/client-tool.test.mjs && git commit -m "feat(business-agent): call A2A v0.3 agents"`.

## Task 4: Wire Runtime Address Injection and the Startup Command

**Files:** Modify `business-agent/bundle/cordis.patch.yml`, `business-agent/bundle/test/config.mjs`, and `business-agent/start-dev.ps1`.

**Interfaces:** The bundle reads `A2A_LISTEN_HOST`, `A2A_LISTEN_PORT`, and `A2A_PUBLIC_BASE_URL`. The launcher exposes `-A2AHost`, `-A2APort`, and `-A2APublicBaseUrl` and passes those values through the three environment variables.

- [ ] **Step 1: Make the bundle test expect a dedicated loopback listener.** Assert that evaluated configuration resolves to host `127.0.0.1`, port `3082`, and an omitted public base by default; add an environment-controlled case that resolves `0.0.0.0`, `3182`, and `http://agent.internal:3182`.
- [ ] **Step 2: Run the bundle test and observe failure.** Run `pnpm --filter @deepseek-ai/dsh-business-agent test`; expect the A2A configuration assertion to fail.
- [ ] **Step 3: Add runtime expressions to the Bundle patch.** Use deployment-owned values without a checked-in IP:

```yaml
listener:
  host: !!js process.env.A2A_LISTEN_HOST ?? '127.0.0.1'
  port: !!js Number(process.env.A2A_LISTEN_PORT ?? 3082)
publicBaseUrl: !!js process.env.A2A_PUBLIC_BASE_URL
```

- [ ] **Step 4: Update the config test loader for `!!js`.** Construct a `js-yaml` scalar type for `tag:yaml.org,2002:js`, evaluate only the three exact expressions owned by this fixture with a supplied environment object, and reject any unrecognized expression so the test does not become a general code evaluator.
- [ ] **Step 5: Add launcher parameters and validation.** Default `-A2AHost` to `127.0.0.1` and `-A2APort` to `3082`; when `-A2AHost 0.0.0.0` is selected without `-A2APublicBaseUrl`, fail before profile setup with an example such as `http://192.168.1.10:3082`.
- [ ] **Step 6: Export runtime values and print both addresses.** Set the three A2A environment variables only for the child launch, keep the Web URL at `127.0.0.1:$Port`, and print the exact Agent Card and RPC URLs derived from `-A2APublicBaseUrl` or the loopback default.
- [ ] **Step 7: Extend `-ReplaceExisting` safely.** Resolve and stop only the exact listeners on `$Port` and `$A2APort`, report each PID, and leave all other processes untouched.
- [ ] **Step 8: Run bundle and launcher checks.** Run the bundle test, `powershell -NoProfile -File business-agent/start-dev.ps1 -?`, and PowerShell parser validation; expect config assertions and parameter help to pass without starting the application.
- [ ] **Step 9: Commit the deployment slice.** Run `git add business-agent/bundle/cordis.patch.yml business-agent/bundle/test/config.mjs business-agent/start-dev.ps1 && git commit -m "feat(business-agent): configure A2A LAN startup"`.

## Task 5: Prove Exact Python 0.3.2 Interoperability

**Files:** Create `business-agent/tests/fixtures/a2a-python-v032-requirements.txt`, `a2a-python-v032-peer.py`, `business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs`, and `business-agent/verify-a2a-python-v032.ps1`; modify the plugin package test only if an explicit script name improves discovery.

**Interfaces:** `a2a-python-v032-peer.py client <base-url>` drives a JavaScript bridge. `a2a-python-v032-peer.py server` prints one JSON line containing its assigned `baseUrl` and then serves until terminated. `DSH_A2A_PYTHON032` names the isolated interpreter used by the Node test.

- [ ] **Step 1: Pin the real parser package.** Put exactly `a2a-sdk[http-server]==0.3.2` in `a2a-python-v032-requirements.txt`; the Python script must assert `importlib.metadata.version('a2a-sdk') == '0.3.2'` before either mode runs.
- [ ] **Step 2: Write the Python client mode.** Resolve `/.well-known/agent-card.json` with `A2ACardResolver`, build `ClientFactory(ClientConfig(httpx_client=client, streaming=True))`, and send this package-native message:

```py
message = Message(
    role=Role.user,
    message_id=str(uuid.uuid4()),
    parts=[Part(root=TextPart(text='python-to-js'))],
)
async for event in a2a_client.send_message(message):
    print(json.dumps(serialize_event(event)), flush=True)
```

- [ ] **Step 3: Write the Python server mode.** Build an `AgentCard` with `protocol_version='0.3.0'`, `preferred_transport='JSONRPC'`, and a dynamically assigned JSON-RPC URL. Implement an `AgentExecutor` that uses `TaskUpdater.submit()`, `start_work()`, `add_artifact([Part(root=TextPart(text=f'py032:{context.get_user_input()}'))])`, and `complete()`; serve `A2AStarletteApplication(...).build()` through Uvicorn on a socket bound to `127.0.0.1:0`.
- [ ] **Step 4: Write the self-skipping Node interoperability test.** Skip with a precise message when `DSH_A2A_PYTHON032` is absent. When present, start the JavaScript test bridge and run Python client mode; assert the parsed terminal event contains `reply:python-to-js`. Then start Python server mode, read its JSON readiness line, call it with `A2AAgentClient`, and assert `output === 'py032:js-to-python'`.
- [ ] **Step 5: Cover streaming, lookup, and cancellation on the Python-to-JavaScript direction.** Have client mode stream one message, call `get_task(TaskQueryParams(id=task_id))`, start a barrier-held request, call `cancel_task(TaskIdParams(id=task_id))`, and emit a compact JSON verdict that Node asserts field by field.
- [ ] **Step 6: Run without the Python environment.** Run the normal bridge package test; expect the interoperability test to report one intentional skip while every JavaScript test passes.
- [ ] **Step 7: Add the reproducible PowerShell runner.** Create or reuse `tmp/a2a-python-v032-venv`, run `python -m pip install -r` only when the exact package is absent, set `DSH_A2A_PYTHON032` to the venv interpreter, build the bridge, and run only `python-v032-interop.test.mjs`.
- [ ] **Step 8: Run the exact-version smoke.** Run `powershell -NoProfile -File business-agent/verify-a2a-python-v032.ps1`; expect both directions, streaming, lookup, and cancellation to pass with package version `0.3.2` printed once.
- [ ] **Step 9: Commit the interoperability slice.** Run `git add business-agent/tests/fixtures/a2a-python-v032-* business-agent/plugins/a2a-bridge/test/python-v032-interop.test.mjs business-agent/verify-a2a-python-v032.ps1 && git commit -m "test(business-agent): verify Python A2A 0.3.2 interop"`.

## Task 6: Update Decision Records, Operator Documentation, and Final Verification

**Files:** Modify the README and Agent Note pairs listed in the File Map and refresh each `.i18n.yaml` record.

**Interfaces:** Documentation must show the direct LAN command and container environment without claiming that `0.0.0.0` is a client URL.

- [ ] **Step 1: Update the plugin reference pair.** Document dual v1.0/v0.3 support, `listener.host`, `listener.port`, runtime `publicBaseUrl`, optional research authentication, exact URLs, shutdown behavior, and unsupported methods.
- [ ] **Step 2: Update Bundle and top-level quick-start pairs.** Replace the shared-port claim with Web `127.0.0.1:3081` plus A2A `127.0.0.1:3082`, and show this direct LAN command:

```powershell
powershell -File business-agent\start-dev.ps1 -NoOpen `
  -A2AHost 0.0.0.0 `
  -A2APublicBaseUrl http://192.168.1.10:3082
```

- [ ] **Step 3: Update the migration pair.** Add port `3082`, container variables, firewall reachability, Card verification with `Invoke-RestMethod`, and the rule that Docker/Kubernetes deployments advertise a Service, ingress, load balancer, or stable host address rather than a transient container IP.
- [ ] **Step 4: Update the existing implemented Agent Note.** State that the bridge exposes v1.0 and v0.3 JSON-RPC through the official compatibility layer, that the dedicated listener prevents shared Host exposure, and that the runtime owns the advertised address. Retain the existing alternatives and add the rejected shared-wildcard-listener and mandatory-proxy alternatives.
- [ ] **Step 5: Refresh every changed translation pair.** Run `pnpm run verify-translation-pairing --write <english-path>` separately for the plugin README, Bundle README, Business Agent README, migration README, and Agent Note, then run the named checks for all five pairs.
- [ ] **Step 6: Run focused product verification.** Run the bridge build/test, Bundle build/test, `business-agent` vertical slice, and `powershell -NoProfile -File business-agent/verify-a2a-python-v032.ps1`; expect all non-network-independent checks and the exact Python smoke to pass.
- [ ] **Step 7: Verify the unchanged model-visible tool.** Run `pnpm run test:snapshot -- -t business-a2a-call`; expect the existing snapshot to pass without re-recording because the tool schema and output stay unchanged.
- [ ] **Step 8: Select and run outgoing checks with `dsh-pre-push-checks`.** Include focused typecheck/lint/docs commands, `pnpm run test:docs`, `pnpm run doc-sync`, and `git diff --check`; record only commands actually executed and distinguish host limitations from product failures.
- [ ] **Step 9: Inspect the complete diff.** Confirm there are no `packages/`, `apps/`, credentials, fixed deployment IPs, virtual environments, `lib/` outputs, or unrelated user changes in the commit set.
- [ ] **Step 10: Commit documentation and decision records.** Run `git add business-agent .agents/notes/implemented/feature/2026-09-20-a2a-bridge.* && git commit -m "docs(business-agent): document A2A compatibility deployment"`.

## Completion Gate

The work is complete only when the exact Python `a2a-sdk==0.3.2` smoke passes in both directions; v1.0 integration still selects v1 methods; another machine can reach the dedicated A2A Card and JSON-RPC URL without exposing the DSH Web listener; a changed `A2A_PUBLIC_BASE_URL` changes the advertised address without rebuilding; bind failure and streaming shutdown tests pass; all focused product, snapshot, documentation, and outgoing checks either pass or have a separately reported host limitation; and the final diff stays within `business-agent/`, the existing A2A Agent Note triplet, and the two Superpowers document triplets.
