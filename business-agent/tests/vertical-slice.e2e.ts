import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createService, tick } from '@deepseek-ai/dsh-business-workorder-service'
import {
  launchWebScaffold,
  watchConsole,
  type WebScaffold,
} from '../../apps/web/tests/scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from '../../apps/web/tests/support.ts'

const REPLAY_FIXTURE = fileURLToPath(new URL(
  '../../snapshots/session/business-workorder-vertical-slice/session.v3.jsonl',
  import.meta.url,
))
const BUNDLE_MANIFEST = fileURLToPath(new URL('../bundle/package.json', import.meta.url))
const PROMPT = 'Start work order WO-MVP-001 and display its first structured interaction form. Then reply exactly FORM_READY.'

function controlledExecutor(): {
  submit(activity: { id: string }): void
  poll(activity: { id: string }): boolean
  complete(activityId: string): void
} {
  const submitted = new Set<string>()
  const completed = new Set<string>()
  return {
    submit(activity) { submitted.add(activity.id) },
    poll(activity) { return completed.delete(activity.id) },
    complete(activityId) {
      if (!submitted.has(activityId)) throw new Error(`activity ${activityId} was not submitted`)
      completed.add(activityId)
    },
  }
}

describe('business workorder vertical slice', () => {
  let service: ReturnType<typeof createService>
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let overlayRoot: string
  let stopToolObserver: (() => void) | undefined
  let consoleTripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const executor = controlledExecutor()
    service = createService({
      port: 0,
      debug: true,
      executor,
      engineIntervalMs: 60_000,
      corsOrigins: ['*'],
      now: () => '2026-09-18T00:00:00.000Z',
    })
    const { url } = await service.listen()
    overlayRoot = await mkdtemp(join(tmpdir(), 'dsh-business-web-'))
    const overlayPath = join(overlayRoot, 'workorder.overlay.yml')
    await writeFile(overlayPath, [
      '- id: ui-sidebar-terminal',
      '  disabled: true',
      '- id: ui-sidebar-files',
      '  disabled: true',
      '- insert:',
      '    - id: business-workorder-host',
      "      name: '@deepseek-ai/dsh-business-workorder-host'",
      '      config:',
      `        serviceUrl: ${url}`,
      '        maxConsecutiveWakes: 3',
      '        reconnectInitialDelayMs: 5',
      '        reconnectMaxDelayMs: 20',
      '    - id: business-workorder-mcp',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: workorder',
      '        transport: streamable-http',
      `        url: ${url}/mcp`,
      '        failOnStartupError: true',
      '    - id: business-workorder-ui',
      "      name: '@deepseek-ai/dsh-business-workorder-ui'",
      '      config:',
      `        serviceUrl: ${url}`,
      '        orderId: WO-MVP-001',
      '    - id: business-workorder-debug',
      "      name: '@deepseek-ai/dsh-business-workorder-debug'",
      '      config:',
      `        serviceUrl: ${url}`,
      '        orderId: WO-MVP-001',
      '        traceLimit: 100',
      '',
    ].join('\n'))
    scaffold = await launchWebScaffold({
      extraInstallAnchors: [BUNDLE_MANIFEST],
      extraOverlayPath: overlayPath,
      replayFixture: REPLAY_FIXTURE,
      compareReplaySession: false,
    })
    stopToolObserver = scaffold.ctx.on('tools/result', (execution, result) => {
      if (result.isError) return
      if (execution.name === 'mcp__workorder__start_order') {
        executor.complete('activity-fetch-customer')
        tick(service.state, executor)
      }
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    consoleTripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  })

  afterAll(async () => {
    const failures: unknown[] = []
    stopToolObserver?.()
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    await service?.close().catch((error: unknown) => failures.push(error))
    if (overlayRoot !== undefined) await rm(overlayRoot, { recursive: true, force: true })
      .catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'business workorder browser teardown failed')
  })

  it('renders the service-owned interaction in conversation and the waiting order on the board', async () => {
    onTestFailed(() => saveFailureShot(page, 'business-workorder-vertical-slice'))
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled

    await expect.poll(
      () => service.state.orders.get('WO-MVP-001')?.activities[1]?.status,
      { timeout: 15_000 },
    ).toBe('waiting')
    const agent = scaffold.ctx.agents.get(sessionId)
    expect(agent).toBeDefined()
    const notices = agent?.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'business-workorder-host') ?? []
    expect(notices).toHaveLength(1)

    await page.getByText('2 tool calls', { exact: true }).click()
    await expect.poll(() => page.getByText('补充授信分析参数', { exact: true }).count()).toBe(1)
    await expect.poll(() => page.getByText('授信期限（月）', { exact: false }).count()).toBeGreaterThan(0)
    await expect.poll(() => page.getByText('担保方式', { exact: false }).count()).toBeGreaterThan(0)
    await expect.poll(() => page.getByText('补充说明', { exact: false }).count()).toBeGreaterThan(0)
    await expect.poll(() => page.getByRole('button', { name: 'Submit and continue' }).count()).toBe(1)

    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    const panel = page.locator('[data-workorder-state="running"]')
    await panel.waitFor({ timeout: 15_000 })
    await expect.poll(() => page.getByText('Workspace files', { exact: true }).count()).toBe(0)
    await expect.poll(() => page.getByText('New terminal', { exact: true }).count()).toBe(0)
    await expect.poll(() => panel.getByText('Waiting', { exact: true }).count()).toBe(1)
    await expect.poll(() => panel.getByText('customer-master.json', { exact: true }).count()).toBe(2)
    await expect.poll(() => panel.getByRole('button').count()).toBe(1)
    await expect.poll(() => panel.getByRole('button', { name: 'Refresh' }).count()).toBe(1)
    await page.getByRole('button', { name: 'Expand mock debug panel' }).click()
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: 'Reset work order' }).click()
    const resetPanel = page.locator('[data-workorder-state="ready"]')
    await resetPanel.waitFor({ timeout: 15_000 })
    await expect.poll(() => resetPanel.getByText('Pending', { exact: true }).count()).toBe(5)
    await expect.poll(() => page.getByText('Work order reset to its initial state', { exact: true }).count()).toBe(1)
    expect(agent?.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'business-workorder-host')).toHaveLength(1)
    expect(consoleTripwire.warnings).toEqual([])
    expect(consoleTripwire.pageErrors).toEqual([])
  })
})
