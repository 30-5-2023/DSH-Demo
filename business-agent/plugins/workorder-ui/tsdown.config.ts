import { defineConfig } from 'tsdown'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'

const id = '@deepseek-ai/dsh-business-workorder-ui'
const browserExternals = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-api-session-controller/client',
  '@deepseek-ai/dsh-client-ui-tool/client',
])

const cssPrefix = '\0business-workorder-css:'
const cssSuffix = '.mjs'

/** Compile a CSS Module and inject its stylesheet when the client factory loads. */
const cssModules = {
  name: 'business-workorder-css-modules',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css') || importer === undefined) return null
    return cssPrefix + resolve(dirname(importer), source) + cssSuffix
  },
  async load(this: { addWatchFile: (file: string) => void }, virtualId: string) {
    if (!virtualId.startsWith(cssPrefix)) return null
    const file = virtualId.slice(cssPrefix.length, -cssSuffix.length)
    this.addWatchFile(file)
    const result = transform({
      filename: file,
      code: await readFile(file),
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classes = Object.fromEntries(
      Object.entries(result.exports ?? {}).map(([local, value]) => [local, value.name]),
    )
    const tagId = `${id}/${basename(file)}`
    return [
      `const css = ${JSON.stringify(result.code.toString())};`,
      `const tagId = ${JSON.stringify(tagId)};`,
      'if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {',
      '  const tag = document.createElement("style");',
      `  tag.dataset.plugin = ${JSON.stringify(id)};`,
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      `export default ${JSON.stringify(classes)};`,
    ].join('\n')
  },
}

export default defineConfig([
  {
    name: id,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
  {
    name: `${id}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: specifier => browserExternals.has(specifier),
      alwaysBundle: specifier => !browserExternals.has(specifier),
    },
    plugins: [cssModules],
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapExcludeSources: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
