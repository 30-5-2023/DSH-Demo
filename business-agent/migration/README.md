# Business Agent migration and verification

English | [中文](README.zh.md)

## Summary

This guide moves the current Business Agent MVP to another Windows computer and verifies it without an existing checkout. The reliable MVP delivery is a source archive of this complete DSH fork because the Business Agent Bundle still resolves `workspace:^` packages and uses the built DSH CLI and Web application. A partial directory package works only when the target already has the exact same DSH base revision. Secrets, generated profiles, dependency folders, and local runtime state must not be copied.

## Table of Contents

- [Changed directories](#changed-directories)
- [Choose a delivery package](#choose-a-delivery-package)
- [Prepare the target computer](#prepare-the-target-computer)
- [Build and verify](#build-and-verify)
- [Start the modules](#start-the-modules)
- [End-to-end debugging](#end-to-end-debugging)
- [Troubleshooting](#troubleshooting)
- [Dev Note](#dev-note)

-----

<a id="changed-directories"></a>
## Changed directories

The business-specific implementation does not modify `packages/` or `apps/`. The following directory-level list is sufficient for change review and migration planning; use Git for the exact file list.

| Path | Content | Required at runtime |
|---|---|---|
| `business-agent/bundle/` | Business Bundle and Cordis Profile patch | Yes |
| `business-agent/plugins/a2a-bridge/` | A2A v0.3/v1.0 calls, file transfer, and hosted downloads | Yes when A2A is enabled |
| `business-agent/plugins/workorder-host/` | Session binding, event consumption, wake routing, and wake trace feed | Yes |
| `business-agent/plugins/workorder-ui/` | Read-only right Sidebar work-order page | Yes |
| `business-agent/plugins/workorder-debug/` | Floating mock reset controls and wake trace inspection | Development only |
| `business-agent/workorder-service/` | Independent mock work-order HTTP, SSE, and MCP service | Yes for the mock deployment |
| `business-agent/start-dev.ps1` and `business-agent/setup-profile.ps1` | Profile initialization and Web launch | Yes for this Windows launch path |
| `business-agent/tests/` | Cross-package and vertical-slice verification | No |
| `business-agent/*.md`, `business-agent/diagrams/`, and `business-agent/tools/` | Design, development, migration, and diagram sources | No |
| `snapshots/session/business-workorder-vertical-slice/` and `snapshots/session/business-a2a-call/` | Keyless recorded Session verification | No |
| `.agents/notes/implemented/feature/2026-09-17-business-workorder-agent*` and `2026-09-20-a2a-bridge*` | Implemented architecture decision records | No |
| `pnpm-workspace.yaml` and `pnpm-lock.yaml` | Workspace registration and exact dependency resolution | Yes when building from source |

-----

<a id="choose-a-delivery-package"></a>
## Choose a delivery package

Use the complete repository archive for a computer that has no DSH source. Use the smaller change package only when the receiver can prove that its base repository is the same revision; mixing these directories with another DSH revision is not a supported deployment path.

### Complete repository archive (recommended)

Commit every intended file before creating the archive because `git archive` excludes uncommitted and untracked files. Run these commands at the repository root on the source computer:

```powershell
git status --short
git diff --check
$businessRevision = git rev-parse --short HEAD
git archive --format=zip --output "..\deepseek-harness-business-agent-$businessRevision.zip" HEAD
```

Send the resulting ZIP and the full commit id from `git rev-parse HEAD`. Do not include `.env`, `tmp/`, `node_modules/`, a generated DSH home, logs, or API keys. The archive contains source but no Git history; the target does not need a pre-existing checkout.

### Change package for an identical base

When the target already has the exact base revision, send `business-agent/`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`. Include `snapshots/session/business-workorder-vertical-slice/` and `snapshots/session/business-a2a-call/` only when the target will run recorded Session checks. Include the Agent Notes only for development review. Copy the whole listed directories instead of selecting individual compiled files, then install and build again on the target.

### Artifact-only delivery

The current MVP does not produce a supported standalone binary or portable plugin ZIP. Copying `lib/` and `node_modules/` is unsafe because the Profile installer must resolve workspace packages and pnpm links can contain machine-specific paths. An artifact-only deployment needs a separate release task that packs the Bundle, its four plugins, the mock service, the DSH runtime, and platform-specific native dependencies.

-----

<a id="prepare-the-target-computer"></a>
## Prepare the target computer

The target computer needs Windows PowerShell, network access to the configured npm registry, Node.js `^22.19.0` or `>=24.0.0`, and pnpm `11.7.0`. Use the same operating system and CPU architecture as the source when native dependencies are reused; a clean target build is preferred.

1. Extract the complete archive into a short path, for example `C:\work\deepseek-harness`.
2. Install or activate pnpm `11.7.0`. If Corepack is available, run `corepack enable` and `corepack prepare pnpm@11.7.0 --activate`.
3. Create a root `.env` locally with `DEEPSEEK_API_KEY`. Add `DEEPSEEK_BASE_URL` only when the deployment uses a compatible non-default endpoint.
4. Keep TCP ports `8090`, `3081`, and `3082` available. Open inbound TCP 3082 in the target firewall when another machine must call A2A; keep 3081 loopback-only.

Never send the source computer's `.env` or generated `tmp/business-agent-dsh-home`. The target launcher creates its own isolated Profile state.

-----

<a id="build-and-verify"></a>
## Build and verify

Run the installation and full build once from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm run build
```

The service and each added DSH package can then be verified independently. Stop at the first failed command and repair that module before continuing.

```powershell
pnpm --filter @deepseek-ai/dsh-business-workorder-service build
pnpm --filter @deepseek-ai/dsh-business-workorder-service test
pnpm --filter @deepseek-ai/dsh-business-workorder-host build
pnpm --filter @deepseek-ai/dsh-business-workorder-host test
pnpm --filter @deepseek-ai/dsh-business-workorder-ui build
pnpm --filter @deepseek-ai/dsh-business-workorder-ui test
pnpm --filter @deepseek-ai/dsh-business-workorder-debug build
pnpm --filter @deepseek-ai/dsh-business-workorder-debug test
pnpm --filter @deepseek-ai/dsh-business-agent build
pnpm --filter @deepseek-ai/dsh-business-agent test
pnpm --filter @deepseek-ai/dsh-business-a2a-bridge build
pnpm --filter @deepseek-ai/dsh-business-a2a-bridge test
pnpm --filter @deepseek-ai/dsh-business-agent-tests test
```

The package tests do not require a model API key. A real conversation with the Agent does require the target computer's key. A machine with Python 3.10+ can also run `pwsh -NoProfile -File business-agent/verify-a2a-python-v032.ps1` to create an isolated venv and verify the exact `a2a-sdk==0.3.2` path.

-----

<a id="start-the-modules"></a>
## Start the modules

The runtime has two processes. The mock work-order service is one process; the Host, right Sidebar UI, and debug plugin are built separately but the `business-agent` Bundle loads them together inside the DSH Web process.

### Terminal 1: mock work-order service

Run the development service with the reset endpoint enabled:

```powershell
pnpm --filter @deepseek-ai/dsh-business-workorder-service start
```

The service listens on `http://127.0.0.1:8090`. Verify it from another terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:8090/health
Invoke-RestMethod http://127.0.0.1:8090/orders/WO-MVP-001
```

For a run without mock reset support, use `node business-agent/workorder-service/bin/serve.js --port 8090`. The floating debug panel remains visible, but its reset action returns an error because the debug endpoint is absent.

### Terminal 2: DSH Web and all plugins

Start the Profile through the supported DSH application entry point:

```powershell
powershell -ExecutionPolicy Bypass -File business-agent\start-dev.ps1 -ReplaceExisting
```

Use `-NoOpen` when the script must not open the default browser. On first start, the launcher creates an isolated `business-agent` Profile, installs the local Bundle, starts Web on `http://127.0.0.1:3081/`, and starts A2A on `http://127.0.0.1:3082/`. After replacing package contents on an existing target, refresh the Profile before starting:

```powershell
powershell -ExecutionPolicy Bypass -File business-agent\setup-profile.ps1 -Force
powershell -ExecutionPolicy Bypass -File business-agent\start-dev.ps1 -ReplaceExisting
```

For direct intranet calls, keep Web on loopback and expose only A2A:

```powershell
powershell -ExecutionPolicy Bypass -File business-agent\start-dev.ps1 -NoOpen `
  -A2AHost 0.0.0.0 `
  -A2APublicBaseUrl http://192.168.1.10:3082
Invoke-RestMethod http://192.168.1.10:3082/.well-known/agent-card.json
```

Replace the example IP with the target computer's stable reachable address. Containers set `A2A_LISTEN_HOST=0.0.0.0`, `A2A_LISTEN_PORT=3082`, and `A2A_PUBLIC_BASE_URL` at runtime. Docker and Kubernetes deployments advertise a Compose service, Kubernetes Service, ingress, load balancer, or stable host address instead of a transient container IP.

The Bundle accepts optional `A2A_INLINE_FILE_MAX_BYTES`, `A2A_MAX_FILE_BYTES`, `A2A_FILE_RETENTION_MS`, comma-separated `A2A_FILE_URL_ALLOWED_ORIGINS`, and comma-separated absolute `A2A_PUBLISH_FILE_ALLOWED_ROOTS`. Inject them with the deployment configuration rather than editing the image. A path passed to `call_a2a_agent.files` or `publish_a2a_file` must exist on the machine running that Agent and resolve inside its Session workspace or an allowed root. The peer receives inline bytes or an HTTP URL, not that local path; keep TCP 3082 reachable for large-file downloads until the configured link lifetime ends.

When the called Agent returns `input-required`, keep the returned `task_id` and send the answer through `message/send` or `message/stream` on that same Task. A v0.3 operator can inspect it with `tasks/get`; there is no `message/get` method. The bridge accepts the documented structured response schema or plain text, while any FilePart returned beside the interaction is guidance or input material and cannot answer the question. The default inbound wait is five minutes and retains one context-concurrency slot; restarting the Host fails that pending Task because the live question wait is in memory. See the [A2A bridge reference](../plugins/a2a-bridge/README.md#continue-input-required-tasks) for both schema URNs and the exact answer fields.

Do not launch the Host, UI, or debug plugin with `node` directly. Their Cordis services and Client injection are valid only inside the assembled Profile.

-----

<a id="end-to-end-debugging"></a>
## End-to-end debugging

This sequence checks the service, MCP tools, right Sidebar, human interruption, Agent wake delivery, and debug observations together.

1. Open `http://127.0.0.1:3081/` and confirm that the right Sidebar opens directly to the work-order page.
2. Expand the floating **Mock Debug** card and select **Reset work order**. The card should show the configured order and an empty or newly updated wake trace list.
3. In a new conversation, ask the Agent to query and start `WO-MVP-001`.
4. Observe activities 1 and 2 complete automatically. Their progress events appear in the wake trace as filtered decisions and do not enter the Agent conversation.
5. When activity 3 waits for a person, inspect the expanded wake trace. It shows the service event, the wake decision, target Session, Agent state, delivery method, and exact message sent to the Agent.
6. A running Agent receives the message through `inject()`. An idle Agent receives it through `followup()`.
7. Tell the Agent to start activity 3, then explicitly report that the offline review is complete. The Agent records completion through MCP, activities 4 and 5 run automatically, and the right Sidebar ends at `5/5` and `done`.
8. Select **Refresh work order** only to fetch the latest service snapshot. It does not reset business state.

Wake traces are development observations held in the DSH Host process. They are not written to the Agent context, retain at most 100 entries with the current Bundle configuration, and disappear when the DSH Web process restarts.

-----

<a id="troubleshooting"></a>
## Troubleshooting

| Symptom | Check and recovery |
|---|---|
| `apps/cli/lib/bin.js` or `apps/web/dist/index.html` is missing | Run `pnpm run build` at the repository root. |
| The Bundle cannot resolve a `workspace:^` package | Use the complete repository at the recorded revision, run `pnpm install --frozen-lockfile`, and do not copy only `lib/`. |
| Port `8090`, `3081`, or `3082` is occupied | Stop the old process. `start-dev.ps1 -ReplaceExisting` handles the exact Web and A2A listener ports. |
| Another machine cannot fetch the Agent Card | Confirm TCP 3082 firewall reachability, use the advertised URL rather than `0.0.0.0`, and verify `A2A_PUBLIC_BASE_URL` names a stable reachable address. |
| A peer receives a large-file URL but cannot download it | Confirm the URL uses the reachable `A2A_PUBLIC_BASE_URL`, TCP 3082 remains open, the link has not expired, and no proxy strips `GET` or `HEAD`. Range requests are intentionally unsupported. |
| `call_a2a_agent.files` or `publish_a2a_file` rejects a path | Put the file in the active Session workspace or add its absolute root to `A2A_PUBLISH_FILE_ALLOWED_ROOTS`; do not pass a path that exists only on the peer. |
| An `input-required` Task fails after the Host restarts | Start a new Task. Task state is durable, but the live `ask_user_question` wait cannot survive a process restart. |
| The Web starts but the work-order page cannot load | Start Terminal 1 first and verify `/health`; then verify that all service URLs in `business-agent/bundle/cordis.patch.yml` use the same port. |
| Reset fails with HTTP 404 | Start the service through its package `start` script or add `--debug` to the direct service command. |
| The Agent cannot call work-order tools | Verify `/mcp`, rebuild the Bundle, run `setup-profile.ps1 -Force`, and restart the Web process. |
| No wake trace appears after restart | Generate a new work-order event. The trace feed is intentionally in memory. |
| The right Sidebar updates but the Agent is not notified | Only events with `needsHuman: true` are delivered; normal progress and completion are filtered. |

-----

## Dev Note

The MVP source archive is the current deployment unit. A source-free, artifact-only installer is not implemented.
