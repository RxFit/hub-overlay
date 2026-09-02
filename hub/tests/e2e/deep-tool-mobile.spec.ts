import { test, expect, type Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'

/* ════════════════════════════════════════════════════════════════════════════
   E2E — Deep Research on a phone: the report must always be reachable.

   Regression guard for the "gold bar does nothing" report: after a run
   landed, going back to the chat left every "tool is active" marker lit (the
   skill badge, the gold edge bar) while the panel itself was unreachable —
   the edge tap only flipped a tab flag and never un-collapsed the panel, and
   collapsing never showed the edge in the first place. These tests drive the
   real phone layout (390px, touch) through every way back in.

   Also locks the composer chips: plain text, no emoji, and an even split of
   the full composer width.

   Auth + backend as in left-panel-inject.spec.ts: a real next-auth cookie,
   every /api/* mocked in the browser.
   ════════════════════════════════════════════════════════════════════════════ */

const SECRET = 'playwright-e2e-secret'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

const REPORT_MD = [
  '# Churn drivers', '', 'Price is the driver.', '',
  '```json',
  JSON.stringify({
    title: 'Churn drivers',
    summary: 'Price is the driver.',
    sections: [{ heading: 'Evidence', body: 'Three of four cohorts cite price.' }],
    sources: [{ title: 'Cohort export', url: 'https://example.com/cohorts' }],
  }),
  '```',
].join('\n')

const LANDED_RUN = {
  id: 'run-1', tool: 'deep-research', status: 'succeeded', liveStatus: 'succeeded',
  brief: 'Why are customers churning?', resultMd: REPORT_MD, errorClass: null, error: null,
  userEmail: 'danny@rxfitatx.com', chatId: null, jobId: 'j1', attempt: 1, model: 'gemini',
  latencyMs: 60_000, usage: null,
  createdAt: new Date(Date.now() - 300_000).toISOString(), finishedAt: new Date().toISOString(),
}

async function mockBackend(page: Page, saveCalls: unknown[]) {
  const nowIso = new Date().toISOString()
  await page.route('**/api/**', route => route.fulfill({ json: {} }))
  await page.route('**/api/auth/session', route =>
    route.fulfill({
      json: {
        user: { name: 'Test User', email: 'danny@rxfitatx.com', role: 'admin', assignedProjects: ['*'] },
        expires: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }),
  )
  await page.route('**/api/kpis**', route => route.fulfill({ json: { kpis: [], projects: [] } }))
  await page.route('**/api/companies**', route => route.fulfill({ json: { companies: [] } }))
  await page.route('**/api/feed**', route => route.fulfill({ json: { feed: [] } }))
  await page.route('**/api/paperclip/**', route => route.fulfill({ status: 404, json: { error: 'not found' } }))
  await page.route('**/api/google/tasks**', route =>
    route.fulfill({ json: { taskLists: [{ id: 'list-1', title: 'My Tasks', updated: nowIso }] } }),
  )
  await page.route('**/api/google/calendar**', route => route.fulfill({ json: { events: [] } }))
  await page.route('**/api/google/drive**', route => route.fulfill({ json: { files: [] } }))
  await page.route('**/api/google/chat/**', route => route.fulfill({ json: { spaces: [], messages: [] } }))
  await page.route('**/api/tool-artifacts**', route =>
    route.fulfill({
      json: {
        artifacts: [{
          id: 'art-1', toolId: 'deep-think', title: 'Deep Think: Pricing call',
          content: {
            toolId: 'deep-think', title: 'Pricing call',
            sections: [{ id: 's1', type: 'recommendation', title: 'Summary', content: 'Hold the price through Q4.' }],
          },
          contextSummary: null, status: 'active', createdBy: 'danny@rxfitatx.com',
          createdAt: nowIso, updatedAt: nowIso,
        }],
      },
    }),
  )
  await page.route('**/api/tool-context', route => route.fulfill({ json: { contextCard: null } }))
  await page.route('**/api/deep-runs**', route => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname.endsWith('/availability')) {
      return route.fulfill({ json: { available: true, reason: null, workerFresh: true } })
    }
    if (url.pathname === '/api/deep-runs') {
      return route.fulfill({ json: { runs: [LANDED_RUN] } })
    }
    if (url.pathname === '/api/deep-runs/run-1' && method === 'POST') {
      saveCalls.push(route.request().postDataJSON())
      return route.fulfill({ json: { artifact: { id: 'art-1', title: 'Deep Research: Churn drivers', created: true } } })
    }
    if (url.pathname === '/api/deep-runs/run-1') {
      return route.fulfill({ json: { run: LANDED_RUN } })
    }
    return route.fulfill({ json: {} })
  })
}

/** Dispatch a real leftward touch drag on an element (Playwright's touchscreen
 *  only taps). Bubbles, so React's root listener sees it like a finger. */
async function swipeLeft(page: Page, selector: string, from: number, to: number) {
  await page.evaluate(({ selector, from, to }) => {
    const el = document.querySelector(selector) as HTMLElement
    const touchAt = (x: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 400 })
    const fire = (type: string, x: number, ended = false) =>
      el.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: ended ? [] : [touchAt(x)],
        targetTouches: ended ? [] : [touchAt(x)],
        changedTouches: [touchAt(x)],
      }))
    fire('touchstart', from)
    fire('touchmove', Math.round((from + to) / 2))
    fire('touchmove', to)
    fire('touchend', to, true)
  }, { selector, from, to })
}

let saveCalls: unknown[]

test.beforeEach(async ({ page, context, baseURL }) => {
  saveCalls = []
  const sessionToken = await encode({
    token: {
      name: 'Test User', email: 'danny@rxfitatx.com', sub: 'test-user',
      role: 'admin', assignedProjects: ['*'], accessToken: 'fake-access-token',
    },
    secret: SECRET,
  })
  await context.addCookies([{
    name: 'next-auth.session-token', value: sessionToken, url: baseURL!,
    httpOnly: true, sameSite: 'Lax',
  }])
  await mockBackend(page, saveCalls)
  await page.addInitScript(() => localStorage.setItem('hub-onboarded', '1'))
  await page.goto('/', { timeout: 80_000 })
  await expect(page.getByRole('heading', { name: 'AI Assistant' })).toBeVisible({ timeout: 60_000 })
})

const researchChip = (page: Page) => page.getByRole('button', { name: 'Deep Research', exact: true })
const thinkChip = (page: Page) => page.getByRole('button', { name: 'Deep Think', exact: true })
const panel = (page: Page) => page.locator('aside.tool-panel')
const backToChat = (page: Page) => panel(page).getByRole('button', { name: /Back to chat/ })
const edge = (page: Page) => page.getByRole('button', { name: 'Deep Research is active — tap to view' })

test('the deep chips are plain text and split the composer width evenly', async ({ page }) => {
  await expect(researchChip(page)).toBeVisible({ timeout: 30_000 })
  expect((await researchChip(page).textContent())?.trim()).toBe('Deep Research')
  expect((await thinkChip(page).textContent())?.trim()).toBe('Deep Think')

  const a = (await researchChip(page).boundingBox())!
  const b = (await thinkChip(page).boundingBox())!
  const row = (await page.locator('.deep-chips').boundingBox())!
  // Equal halves of the row, flush to both edges (an 8px gap between them).
  expect(Math.abs(a.width - b.width)).toBeLessThan(3)
  expect(Math.abs(a.x - row.x)).toBeLessThan(3)
  expect(Math.abs((b.x + b.width) - (row.x + row.width))).toBeLessThan(3)
  expect(b.x - (a.x + a.width)).toBeGreaterThanOrEqual(6)
  // Both ride on the same line.
  expect(Math.abs(a.y - b.y)).toBeLessThan(2)
})

test('a landed report is reachable again from the edge handle, by swipe, and from the skill badge', async ({ page }) => {
  await researchChip(page).tap()
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByRole('heading', { name: 'Churn drivers' })).toBeVisible({ timeout: 20_000 })
  // Auto-save: the panel asked for the artifact and says so.
  await expect(panel(page).getByText(/Saved to Artifacts/)).toBeVisible({ timeout: 10_000 })
  expect(saveCalls).toEqual([{ action: 'save_artifact' }])

  // Back to chat: the panel leaves, the gold edge handle appears at once.
  await backToChat(page).tap()
  await expect(panel(page)).toBeHidden()
  await expect(edge(page)).toBeVisible()
  await expect(edge(page)).toContainText('Deep Research')

  // The handle must never sit over the composer: Send stays hittable at its
  // centre, and the two boxes do not intersect (a full-height handle covered
  // the right half of Send on a 390px phone).
  const sendBox = (await page.getByRole('button', { name: 'Send message' }).boundingBox())!
  const edgeBox = (await edge(page).boundingBox())!
  const intersects = !(
    edgeBox.y + edgeBox.height <= sendBox.y || edgeBox.y >= sendBox.y + sendBox.height ||
    edgeBox.x + edgeBox.width <= sendBox.x || edgeBox.x >= sendBox.x + sendBox.width
  )
  expect(intersects).toBe(false)
  const hitAtSendCentre = await page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null,
    { x: sendBox.x + sendBox.width / 2, y: sendBox.y + sendBox.height / 2 },
  )
  expect(hitAtSendCentre).toBe('Send message')

  // 1) tap the edge → the SAME landed report, no refetch needed.
  await edge(page).tap()
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByRole('heading', { name: 'Churn drivers' })).toBeVisible()
  await expect(edge(page)).toBeHidden()

  // 2) back to chat, then pull the edge leftward.
  await backToChat(page).tap()
  await expect(panel(page)).toBeHidden()
  await swipeLeft(page, '.tool-edge-indicator', 380, 320)
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByRole('heading', { name: 'Churn drivers' })).toBeVisible()
  // The drawer machine did NOT also open the Activity drawer from that drag.
  await expect(page.locator('aside.panel-right.mobile-open')).toHaveCount(0)

  // 3) back to chat, then tap the skill badge body.
  await backToChat(page).tap()
  await expect(panel(page)).toBeHidden()
  await page.getByRole('button', { name: 'Open the Deep Research panel' }).tap()
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByRole('heading', { name: 'Churn drivers' })).toBeVisible()

  // Still exactly one save request across all of that — the panel stayed mounted.
  expect(saveCalls).toEqual([{ action: 'save_artifact' }])
})

test('the bottom nav still works while a tool is active: Activity opens its drawer, closing it shows the edge', async ({ page }) => {
  await researchChip(page).tap()
  await expect(panel(page)).toBeVisible()

  await page.getByRole('tab', { name: 'Activity' }).tap()
  const drawer = page.locator('aside.panel-right.mobile-open')
  await expect(drawer).toBeVisible()
  await expect(panel(page)).toBeHidden()

  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(edge(page)).toBeVisible()
  await edge(page).tap()
  await expect(panel(page)).toBeVisible()
})

test('"Discuss in chat" from the report lands the user in the chat with the edge handle showing', async ({ page }) => {
  await researchChip(page).tap()
  await expect(panel(page).getByRole('heading', { name: 'Churn drivers' })).toBeVisible({ timeout: 20_000 })
  await page.route('**/api/chat', route =>
    route.fulfill({ contentType: 'text/event-stream', body: 'data: {"text":"ok"}\n\ndata: [DONE]\n\n' }),
  )
  await panel(page).getByRole('button', { name: 'Discuss in chat' }).tap()
  await expect(panel(page)).toBeHidden()
  await expect(edge(page)).toBeVisible()
  await expect(page.getByText(/Let's discuss the research report/)).toBeVisible()
})

test('a panel collapsed on a wide viewport is still reachable after narrowing to a phone', async ({ page }) => {
  // Desktop-width first: the tool panel is a column with a real collapse-to-rail.
  await page.setViewportSize({ width: 1280, height: 900 })
  await researchChip(page).click()
  await expect(panel(page)).toBeVisible()
  await panel(page).getByRole('button', { name: 'Collapse tool panel' }).click()
  await expect(panel(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Expand Deep Research tool panel' })).toBeVisible()

  // Narrow to a phone: the rail is display:none there, so the edge handle
  // must take over — otherwise the report is unreachable again.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(edge(page)).toBeVisible()
  await edge(page).tap()
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByRole('heading', { name: 'Churn drivers' })).toBeVisible({ timeout: 20_000 })
})

test('Escape in the artifact viewer closes only the viewer — the drawer it was opened from stays', async ({ page }) => {
  await page.getByRole('tab', { name: 'Tasks' }).tap()
  const drawer = page.locator('aside.panel-left.mobile-open')
  await expect(drawer).toBeVisible()
  await drawer.getByRole('tab', { name: 'Artifacts' }).tap()
  await drawer.getByRole('listitem', { name: 'Artifact: Deep Think: Pricing call' }).tap()
  const dialog = page.getByRole('dialog', { name: 'Deep Think: Pricing call' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Hold the price through Q4.')

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(drawer).toBeVisible()

  // A second Escape now closes the drawer, as before.
  await page.keyboard.press('Escape')
  await expect(page.locator('aside.panel-left.mobile-open')).toHaveCount(0)
})
