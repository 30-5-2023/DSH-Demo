---
description: "Read-only work-order progress in the DSH right Sidebar, including authoritative snapshot refresh, live connection status, activity resources, and localized loading and failure states."
kind: "package-reference"
---

# Business work-order UI plugin

English | [中文](README.zh.md)

## Summary

The page lets a user follow the MVP work order without adding a second write path beside the conversation. It reads complete snapshots from the business service and uses SSE frames only to request a newer snapshot. The activity list shows ordered status, human-blocking state, and input or output metadata at desktop and narrow widths.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The business Bundle mounts this plugin as the only right-Sidebar guide entry, so opening the right Sidebar displays its work-order page directly.

```yaml
- name: '@deepseek-ai/dsh-business-workorder-ui'
  config:
    serviceUrl: http://127.0.0.1:8090
    orderId: WO-MVP-001
```

| Field | Default | Meaning |
|---|---|---|
| `serviceUrl` | required | HTTP or HTTPS base URL injected into the Web page without credentials, query, or fragment |
| `orderId` | required | Non-empty work-order identifier displayed by the MVP page |

Build and verify its browser artifact independently:

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-ui build
pnpm --filter @deepseek-ai/dsh-business-workorder-ui test
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host entry validates `serviceUrl` and `orderId`, then injects them into each Web page. The tab definition and keyed body use the public right Sidebar registries. The body validates every HTTP snapshot and SSE revision at the browser input, refetches the complete snapshot after a newer frame, and retains the last snapshot when the event stream disconnects. A package-local build configuration emits the browser closure and compiles its CSS Module because the shared Client package discovery covers only `packages/*/*`.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None. This package presents service state in the browser and contributes no model-visible input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The business Bundle defaults to `WO-MVP-001` at `http://127.0.0.1:8090`; a deployment can configure both values, but current-session order selection is not available yet.
- A process restart resets the business service and the page reconnects to the fresh seed snapshot.
- Resource rows show metadata only and do not open or download their content.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
