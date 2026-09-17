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
const PROMPT = 'Start work order WO-MVP-001. When its manual review requires attention, start that activity and finish it after the offline review is complete. Then reply exactly WORKORDER_DONE.'

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
      executor,
      engineIntervalMs: 60_000,
      corsOrigins: ['*'],
      now: () => '2026-09-18T00:00:00.000Z',
    })
    const { url } = await service.listen()
    overlayRoot = await mkdtemp(join(tmpdir(), 'dsh-business-web-'))
    const overlayPath = join(overlayRoot, 'workorder.overlay.yml')
    await writeFile(overlayPath, [
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
      '',
    ].join('\n'))
    scaffold = await launchWebScaffold({
      extraInstallAnchors: [BUNDLE_MANIFEST],
      extraOverlayPath: overlayPath,
      replayFixture: REPLAY_FIXTURE,
      compareReplaySession: false,
    })
    stopToolObserver = scaffold.ctx.on('tools/result', (execution, result) => {
      if (execution.name !== 'mcp__workorder__start_order' || result.isError) return
      executor.complete('activity-auto-review')
      tick(service.state, executor)
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

  it('completes the replayed conversation and renders the final service snapshot', async () => {
    onTestFailed(() => saveFailureShot(page, 'business-workorder-vertical-slice'))
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled

    await expect.poll(() => service.state.orders.get('WO-MVP-001')?.status, { timeout: 15_000 }).toBe('done')
    const agent = scaffold.ctx.agents.get(sessionId)
    expect(agent).toBeDefined()
    const notices = agent?.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'business-workorder-host') ?? []
    expect(notices).toHaveLength(1)

    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    await page.getByText('Current work order', { exact: true }).click()
    const panel = page.locator('[data-workorder-state="done"]')
    await panel.waitFor({ timeout: 15_000 })
    await expect.poll(() => panel.getByText('Done', { exact: true }).count()).toBeGreaterThan(0)
    await expect.poll(() => panel.getByText('复核结论.md', { exact: true }).count()).toBe(1)
    await expect.poll(() => panel.getByRole('button').count()).toBe(1)
    await expect.poll(() => panel.getByRole('button', { name: 'Refresh' }).count()).toBe(1)
    expect(consoleTripwire.warnings).toEqual([])
    expect(consoleTripwire.pageErrors).toEqual([])
  })
})
