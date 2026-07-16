import { test, expect, type Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'

/* ════════════════════════════════════════════════════════════════════════════
   E2E — the mobile/tablet backdrop must not stick over the screen on tap.

   Regression guard for the "stuck hazed-glass" bug: on ≤1024px viewports, the
   swipe hook cleared the backdrop's inline style on every touchend, and a
   `@media (max-width: 1024px)` rule forced `display: block`, so the first tap
   anywhere left a fixed, blurred, z-index-999 backdrop covering the whole screen
   and intercepting every subsequent tap. This test taps a control that does NOT
   open a panel and asserts the backdrop stays hidden, then confirms the backdrop
   still appears on a real panel open and hides again on close.
   ════════════════════════════════════════════════════════════════════════════ */

const SECRET = 'playwright-e2e-secret'

// Tablet width (≤1024px triggers the media query) with touch so touchend fires.
test.use({ viewport: { width: 820, height: 1100 }, hasTouch: true, isMobile: true })

async function mockBackend(page: Page) {
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
  await page.route('**/api/tool-artifacts**', route => route.fulfill({ json: { artifacts: [] } }))
}

const backdropDisplay = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('.mobile-backdrop')
    return el ? getComputedStyle(el).display : 'MISSING'
  })

test.beforeEach(async ({ page, context, baseURL }) => {
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
  await mockBackend(page)
  await page.addInitScript(() => localStorage.setItem('hub-onboarded', '1'))
  await page.goto('/', { timeout: 80_000 })
  await expect(page.getByRole('heading', { name: 'AI Assistant' })).toBeVisible({ timeout: 60_000 })
})

test('a tap on a non-panel control does not leave the backdrop stuck over the screen', async ({ page }) => {
  expect(await backdropDisplay(page)).toBe('none')

  // Tap the EXA Search toggle — a header control that must NOT open any panel.
  // (It occupies the slot the old dark/light toggle used.)
  await page.getByRole('button', { name: /Turn EXA web search (on|off)/ }).first().tap()
  await page.waitForTimeout(300)

  // Backdrop must remain hidden — the bug made it display:block and cover everything.
  expect(await backdropDisplay(page)).toBe('none')

  // And a second control must still be reachable (the backdrop isn't intercepting).
  const center = page.locator('.mobile-backdrop')
  await expect(center).toHaveCount(1)
  const covers = await page.evaluate(() => {
    const el = document.querySelector('.mobile-backdrop') as HTMLElement
    const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
    return el === hit || el.contains(hit)
  })
  expect(covers).toBe(false)
})

test('the backdrop still appears on a real panel open and hides on close', async ({ page }) => {
  expect(await backdropDisplay(page)).toBe('none')

  // Open the left panel via the tablet control bar ("Open Tasks"). exact:true so
  // this doesn't also match the onboarding suggestion chip "Ask: Show my open
  // tasks", which renders during the pre-session-hydration window.
  await page.getByRole('button', { name: 'Open Tasks', exact: true }).tap()
  await expect(page.locator('aside.panel-left.mobile-open')).toBeVisible()
  expect(await backdropDisplay(page)).toBe('block')

  // Escape closes panels → backdrop hidden again.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  expect(await backdropDisplay(page)).toBe('none')
})
