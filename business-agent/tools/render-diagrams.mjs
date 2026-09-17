/**
 * 把 DESIGN.md 里的 mermaid 块渲染成 PNG。
 *
 * 为什么要渲染：DSH 的聊天区与文件预览都不渲染 mermaid（包里搜不到它，
 * markdown 只走 shiki 语法高亮），所以直接在界面上看只会看到源码。
 * 渲染成 PNG 之后，任何地方都能看。
 *
 * 用仓库里已有的 mermaid（website 的依赖）+ 系统自带的 Edge，零额外安装。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import playwright from 'file:///C:/Users/sakura/Desktop/dsh-demo/deepseek-harness/apps/web/node_modules/playwright/index.js'

const { chromium } = playwright
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE = join(ROOT, 'business-agent', 'DESIGN.md')
const OUT_DIR = join(ROOT, 'business-agent', 'diagrams')
const MERMAID = join(ROOT, 'website', 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')

/** 把 `## 一、架构` 这样的标题变成一个安全的文件名。 */
function slug(title) {
  return title
    .replace(/^##\s*/, '')
    .replace(/[、：:]/g, '-')
    .replace(/[^\p{Script=Han}\w-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

/** 从 markdown 里抽出 mermaid 块，用最近的一/二/三级标题命名。 */
function extractBlocks(markdown) {
  const blocks = []
  let currentTitle = 'diagram'
  for (const line of markdown.split(/\r?\n/)) {
    // 三级标题更具体（三张时序图共用一个二级标题），所以谁近用谁。
    if (/^#{1,3} /.test(line)) currentTitle = line
    if (line.trim() === '```mermaid') {
      blocks.push({ title: currentTitle, source: [], collecting: true })
      continue
    }
    const last = blocks.at(-1)
    if (last?.collecting === true) {
      if (line.trim() === '```') {
        last.collecting = false
        continue
      }
      last.source.push(line)
    }
  }
  return blocks
    .filter(block => block.source.length > 0)
    .map((block, index) => ({
      name: `${String(index + 1).padStart(2, '0')}-${slug(block.title)}.png`,
      title: block.title.replace(/^#+\s*/, ''),
      source: block.source.join('\n'),
    }))
}

const blocks = extractBlocks(readFileSync(SOURCE, 'utf8'))
if (blocks.length === 0) throw new Error(`没有在 ${SOURCE} 里找到 mermaid 块`)
mkdirSync(OUT_DIR, { recursive: true })

const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })
page.on('pageerror', error => console.error(String(error)))
page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })

// 把 mermaid 内联进页面：`setContent` 下再加载 file:// 脚本会被拦，
// 而且只加载一次就能在同一个页面里循环渲染，比每次重建页面快得多。
const bundle = readFileSync(MERMAID, 'utf8')
await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
  <style>
    body { margin: 0; padding: 24px; background: #ffffff;
           font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
    #host { display: inline-block; }
  </style>
  <script>${bundle}</script>
</head><body><div id="host"></div></body></html>`)
await page.waitForFunction(() => typeof window.mermaid !== 'undefined')
await page.evaluate(() => {
  window.__diagrams = 0
  // useMaxWidth: false 是关键——默认会把 SVG 缩放到容器宽度，截出来的图小得看不清。
  // 每个图类型有各自的配置键，漏一个那种图就会被缩小。
  window.mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    flowchart: { htmlLabels: true, useMaxWidth: false },
    sequence: { useMaxWidth: false },
    state: { useMaxWidth: false },
  })
})

const written = []
for (const block of blocks) {
  const { svg, error } = await page.evaluate(async (source) => {
    window.__diagrams += 1
    try {
      return { svg: (await window.mermaid.render(`d${String(window.__diagrams)}`, source)).svg, error: null }
    } catch (thrown) {
      return { svg: null, error: String(thrown?.message ?? thrown) }
    }
  }, block.source)
  if (error !== null) {
    process.stdout.write(`  ✗ ${block.title}: ${error}\n`)
    continue
  }
  await page.evaluate((markup) => { document.getElementById('host').innerHTML = markup }, svg)
  const host = await page.$('#host')
  const path = join(OUT_DIR, block.name)
  await host.screenshot({ path })
  written.push(block.name)
  process.stdout.write(`  ✓ ${block.title} → diagrams/${block.name}\n`)
}

await browser.close()
process.stdout.write(`\n共 ${String(written.length)} 张，输出目录 ${OUT_DIR}\n`)
