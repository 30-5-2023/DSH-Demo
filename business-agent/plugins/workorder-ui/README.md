# Business work-order UI plugin

English | [中文](README.zh.md)

This dual-face Client plugin owns the read-only work-order page in the DSH right Sidebar. Task 2 ships only a browser lifecycle marker; Task 5 replaces it with the live panel.

The package uses a local `tsdown` configuration because the repository's shared Client preset intentionally discovers only `packages/*/*`. The emitted `lib/client.js` follows the same `window.__ModuleLoader__` registration protocol and is covered by an artifact lifecycle test.

## Verify

```sh
pnpm --filter @deepseek-ai/dsh-business-workorder-ui build
pnpm --filter @deepseek-ai/dsh-business-workorder-ui test
```

## Model experience

None. This package is a browser-only presentation plugin.

## Known limitations

The Task 2 build renders no work-order content. The live read-only page and its loading, waiting, and error states belong to Task 5.
