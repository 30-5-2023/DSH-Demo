/**
 * 生成 DESIGN.md 里的两张 ASCII 图（各自覆盖在自己的标记对之间）：
 *   architecture-ascii  「一、整体架构」——谁挨着谁、谁在上谁在下
 *   pane-ascii          「三、页面原型」——页面怎么分区、卡片有哪些字段
 *
 * 为什么这两张用 ASCII 而不是 mermaid：它们要的是**空间布局**，而 mermaid 的自动布局
 * 恰好把这个信息丢掉，只剩一堆箭头。时序图与状态机的布局由语义决定，用 mermaid 更
 * 清楚——那部分见 render-diagrams.mjs。
 *
 * 为什么用脚本生成而不是手写：ASCII 图的对齐要按**显示宽度**算（中文算两列），手写
 * 几乎必歪。这里按固定列位摆放，宽度由程序保证，并逐行自检后才写入。
 *
 *   node business-agent/tools/build-architecture-ascii.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'

/** 中文/全角字符在等宽字体里占两列。 */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/
const width = (text) => [...text].reduce((total, char) => total + (WIDE.test(char) ? 2 : 1), 0)

/** 把文本补到指定显示宽度。 */
function pad(text, to) {
  const gap = to - width(text)
  if (gap < 0) throw new Error(`"${text}" 宽 ${String(width(text))}，超出可用 ${String(to)}`)
  return text + ' '.repeat(gap)
}

/** 把若干「列位 → 文本」拼成一行；列位从 1 开始，按显示宽度推进。 */
function place(chunks) {
  let cursor = 1
  let line = ''
  for (const [at, text] of chunks) {
    line += ' '.repeat(at - cursor)
    line += text
    cursor = at + width(text)
  }
  return line
}

/** 一个方框：左边距 + 内宽。`text()` 生成它的某一行。 */
function box(at, inner) {
  return {
    at,
    inner,
    top: () => place([[at, `┌${'─'.repeat(inner)}┐`]]),
    row: (text) => place([[at, `│${pad(` ${text} `, inner)}│`]]),
    /** `teeAt` 是竖线开口的**绝对列位**，可给多个；不给就是一条实底。 */
    bottom: (...teeAt) => {
      if (teeAt.length === 0) return place([[at, `└${'─'.repeat(inner)}┘`]])
      const offsets = [...teeAt].sort((x, y) => x - y).map(tee => tee - at - 1)
      let line = '└'
      let filled = 0
      for (const offset of offsets) {
        line += '─'.repeat(offset - filled) + '┬'
        filled = offset + 1
      }
      line += '─'.repeat(inner - filled) + '┘'
      return place([[at, line]])
    },
  }
}

/** 攒图的行，同时记下每个行段的区间，自检用它定位，免得下标写死对不上。 */
function sheet() {
  const lines = []
  return {
    lines,
    /**
     * 追加一组行。
     * @param rows - 行。
     * @returns 这组行在整张图里的下标区间 `[首行, 末行]`。
     */
    push(...rows) {
      const from = lines.length
      lines.push(...rows)
      return [from, lines.length - 1]
    },
  }
}

// ── 第三节：整体架构 ────────────────────────────────────────────────────────

const SERVICE = box(3, 57)
const PANE = box(3, 12)
const WAKER = box(24, 14)
const AGENT = box(24, 25)
const RIGHT = 52 // ③ 的下行线所在的右边距，也是所有带右边框的行的落点
const A = 14 // ①② 共用的下行线：读接口与事件流，看板与唤醒器各取所需
const C = 52 // ③ 的下行线：工具面直达 agent 宿主
const FORK_L = 6 // ①② 分叉后往左落到看板
const FORK_R = 30 // ①② 分叉后往右落到唤醒器
const WAKE_TEE = 32 // 唤醒器底部往下投递那条线

const architecture = sheet()

// 工单服务就是业务系统，所以上面没有第二层：今日这份是 mock，将来换成业务方的实现，
// 对外的三组接口不变。执行引擎与执行实现都在这一块里面，不是并列的「部分」。
const SERVICE_SPAN = architecture.push(
  SERVICE.top(),
  SERVICE.row('workorder 服务 workorder-service'),
  SERVICE.row('= 业务系统；demo 里是 mock 实现，真实部署由业务方提供'),
  SERVICE.row('独立包与端口 · 零 DSH 依赖'),
  SERVICE.row(''),
  SERVICE.row('执行引擎：认产线结构 · 推状态机 · 判该不该喊人'),
  SERVICE.row('执行实现：活动怎么真跑；demo 里是模拟的'),
  SERVICE.row(''),
  SERVICE.row('产线状态 · 事件流                  MCP 工具面'),
  place([[3, `└${'─'.repeat(A - 4)}┬${'─'.repeat(C - A - 1)}┬${'─'.repeat(SERVICE.at + SERVICE.inner + 1 - C - 1)}┘`]]),
)

const LINE_SPAN = architecture.push(
  place([[A, '│'], [C, '│']]),
  place([[A + 2, '① HTTP 读接口'], [C, '│'], [C + 2, '③ MCP 工具面']]),
  place([[A + 2, '② SSE 事件流'], [C, '│']]),
  place([[A, '│'], [C, '│']]),
  // ①② 在这里分叉：看板与唤醒器各订各的，广播不删、互不影响。
  place([[FORK_L, `┌${'─'.repeat(A - FORK_L - 1)}┴${'─'.repeat(FORK_R - A - 1)}┐`], [C, '│']]),
  place([[FORK_L, '│'], [FORK_R, '│'], [C, '│']]),
  place([[FORK_L, '▼'], [FORK_R, '▼'], [C, '│']]),
)

// 看板与唤醒器都直连服务：正文「看板直连」画在图上就是这两条落线。
const PANE_SPAN = architecture.push(
  place([[PANE.at, PANE.top().trimStart()], [WAKER.at, WAKER.top().trimStart()], [C, '│']]),
  place([[PANE.at, PANE.row('工单看板').trimStart()], [WAKER.at, WAKER.row('唤醒器').trimStart()], [C, '│']]),
  place([[PANE.at, PANE.row('直连·只读').trimStart()], [WAKER.at, WAKER.row('过滤·路由').trimStart()], [C, '│']]),
  place([[PANE.at, PANE.bottom().trimStart()], [WAKER.at, WAKER.bottom(WAKE_TEE).trimStart()], [C, '│']]),
)

architecture.push(
  place([[WAKE_TEE, '│'], [WAKE_TEE + 2, '投递消息'], [C, '│']]),
  place([[WAKE_TEE, '▼'], [C, '│']]),
  place([[AGENT.at, AGENT.top().trimStart()], [C, '│']]),
  place([[AGENT.at, AGENT.row('Agent 宿主（今日 DSH）').trimStart()], [C, '│']]),
  place([[AGENT.at, AGENT.row('左侧对话：用户 ⇄ agent').trimStart()], [AGENT.at + AGENT.inner + 2, '─┘']]),
  place([[AGENT.at, AGENT.bottom().trimStart()]]),
)

// 逐框自检：同一个框的每一行必须一样宽。
const FRAME_CHECKS = [
  ['工单服务框', SERVICE_SPAN],
  ['看板与唤醒器行', PANE_SPAN],
]
let problems = 0
for (const [name, [from, to]] of FRAME_CHECKS) {
  const sizes = new Set(architecture.lines.slice(from, to + 1).map(line => width(line)))
  if (sizes.size !== 1) {
    process.stdout.write(`  ✗ ${name} 各行宽度不一致：${[...sizes].join(' / ')}\n`)
    problems += 1
  }
}
// 从连接线段起，带右边框的行都必须落在右边距上；
// 最后一行是看板框与对话框的底，连接线已在上一行收口，它本来就不到右边距。
for (const [index, line] of architecture.lines.entries()) {
  if (index < LINE_SPAN[0] || index === architecture.lines.length - 1) continue
  if (!'│┐┘'.includes([...line].at(-1) ?? '')) continue
  if (width(line) !== RIGHT) {
    process.stdout.write(`  ✗ 第三节第 ${String(index + 1)} 行宽 ${String(width(line))}，右边框应落在 ${String(RIGHT)}：${line}\n`)
    problems += 1
  }
}

// ── 第六节：右侧页面布局 ────────────────────────────────────────────────────

const PAGE = box(1, 60)

/**
 * 一行活动卡片。
 * @param seq - 步骤号徽章。
 * @param type - 类型徽章。
 * @param title - 活动标题。
 * @param automation - 自动化标记。
 * @param status - 状态。
 * @returns 补好列位的一行。
 */
const cardLine = (seq, type, title, automation, status) => PAGE.row(
  place([[2, seq], [5, type], [14, title], [34, automation], [44, status]]),
)

const paneLines = [
  PAGE.top(),
  PAGE.row('作业区（约 3/4）'),
  PAGE.row(place([[2, '[ 作业记录 ]'], [16, '[ 决策记录 ]'], [36, '← 两个 tab']])),
  PAGE.row(''),
  cardLine('①', '[工具]', '拉取客户主数据', '自动', '已完成'),
  PAGE.row('  输入 工单基本信息 → 输出 customer-master.json'),
  cardLine('②', '[agent]', '生成授信分析报告', '自动', '执行中'),
  PAGE.row('  输入 ←① customer-master.json'),
  cardLine('③', '[手工]', '复核财报口径', '需人工', '等待人工'),
  PAGE.row('  输入 ←② 授信分析报告.md'),
  PAGE.row(''),
  PAGE.row('第 3 步需人工 · 对 agent 说「开始第 3 步」'),
  place([[1, `├${'─'.repeat(PAGE.inner)}┤`]]),
  PAGE.row('交付件区（约 1/4）  来自活动 ①②③ …'),
  PAGE.bottom(),
]

const PAGE_WIDTH = width(paneLines[0])
for (const [index, line] of paneLines.entries()) {
  if (width(line) !== PAGE_WIDTH) {
    process.stdout.write(`  ✗ 第六节第 ${String(index + 1)} 行宽 ${String(width(line))}，应为 ${String(PAGE_WIDTH)}：${line}\n`)
    problems += 1
  }
}

// ── 写回文档 ────────────────────────────────────────────────────────────────

const docPath = new URL('../DESIGN.md', import.meta.url)

/**
 * 用生成结果替换文档里一对标记之间的内容。
 * @param doc - 文档全文。
 * @param name - 标记名。
 * @param lines - 要写进去的行。
 * @returns 替换后的文档。
 */
function writeBlock(doc, name, lines) {
  const begin = `<!-- BEGIN ${name}`
  const end = `<!-- END ${name} -->`
  const from = doc.indexOf(begin)
  const to = doc.indexOf(end)
  if (from < 0 || to < 0) throw new Error(`DESIGN.md 里找不到 ${name} 的标记对`)
  const header = `${begin}（由 tools/build-architecture-ascii.mjs 生成，不要手改） -->\n`
  return `${doc.slice(0, from)}${header}\`\`\`\n${lines.join('\n')}\n\`\`\`\n${doc.slice(to)}`
}

if (problems > 0) {
  process.stdout.write(`\n${String(problems)} 处没对齐，没有写入文档\n`)
  process.exitCode = 1
} else {
  const doc = readFileSync(docPath, 'utf8')
  const replaced = writeBlock(
    writeBlock(doc, 'architecture-ascii', architecture.lines),
    'pane-ascii',
    paneLines,
  )
  if (replaced === doc) {
    process.stdout.write('两张 ASCII 图都已是最新，无需改动\n')
  } else {
    writeFileSync(docPath, replaced)
    process.stdout.write(
      `已更新 DESIGN.md（整体架构 ${String(architecture.lines.length)} 行 + 右侧页面 ${String(paneLines.length)} 行，自检通过）\n`,
    )
  }
}
