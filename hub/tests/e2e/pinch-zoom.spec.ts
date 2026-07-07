import { test, expect, type Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'

/* ════════════════════════════════════════════════════════════════════════════
   E2E — pinch-to-zoom must be allowed WITHOUT breaking the swipe-drawer gesture.

   The viewport used to lock scale (`user-scalable=no`, `maximum-scale=1`) so the
   single-finger horizontal swipe (which opens the left/right panels on mobile)
   wouldn't fight the browser. That was an accessibility regression — low-vision
   users could not pinch-zoom. The fix removes the zoom lock and guards the touch
   handlers so a multi-finger (pinch) gesture never triggers a panel swipe.

   These tests assert:
     (a) the rendered viewport meta no longer disables zoom,
     (b) a single-finger horizontal swipe still opens a panel, and
     (c) a two-finger horizontal gesture does NOT open a panel.
   ════════════════════════════════════════════════════════════════════════════ */

const SECRET = 'playwright-e2e-secret'

// Phone width (≤640px) with touch so the swipe commit logic (which only runs
// at ≤640px) and touchend fire.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

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

/* Dispatch a horizontal swipe on the `.hub-shell` element using native
   TouchEvents. `fingers` controls how many touch points are present — a single
   finger should open a panel; two fingers (pinch) must not. */
async function swipeHorizontal(page: Page, fingers: number) {
  await page.evaluate((fingerCount) => {
    const shell = document.querySelector('.hub-shell') as HTMLElement
    if (!shell) throw new Error('hub-shell not found')

    const y = 420
    const mkTouch = (id: number, x: number) =>
      new Touch({ identifier: id, target: shell, clientX: x, clientY: y })

    const points = (xs: number[]) => {
      const touches: Touch[] = []
      for (let i = 0; i < fingerCount; i++) touches.push(mkTouch(i, xs[i] ?? xs[0]))
      return touches
    }

    const fire = (type: string, touches: Touch[]) =>
      shell.dispatchEvent(
        new TouchEvent(type, {
          touches: type === 'touchend' ? [] : touches,
          targetTouches: type === 'touchend' ? [] : touches,
          changedTouches: touches,
          bubbles: true,
          cancelable: true,
        }),
      )

    // Start near the left edge, drag right well past the commit threshold.
    fire('touchstart', points([40, 60]))
    fire('touchmove', points([90, 110]))
    fire('touchmove', points([180, 200]))
    fire('touchmove', points([300, 320]))
    fire('touchend', points([300, 320]))
  }, fingers)
}

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

test('the viewport meta allows pinch-zoom', async ({ page }) => {
  const content = await page.evaluate(() => {
    const el = document.querySelector('meta[name="viewport"]')
    return el ? el.getAttribute('content') ?? '' : 'MISSING'
  })
  expect(content).not.toBe('MISSING')
  // Zoom must NOT be locked.
  expect(content).not.toContain('user-scalable=no')
  expect(content).not.toContain('user-scalable=0')
  expect(content).not.toMatch(/maximum-scale=1\b/)
  // Responsive baseline preserved.
  expect(content).toContain('width=device-width')
  expect(content).toContain('initial-scale=1')
})

test('a single-finger horizontal swipe still opens the left panel', async ({ page }) => {
  await expect(page.locator('aside.panel-left.mobile-open')).toHaveCount(0)

  await swipeHorizontal(page, 1)

  await expect(page.locator('aside.panel-left.mobile-open')).toBeVisible({ timeout: 5_000 })
})

test('a two-finger (pinch) horizontal gesture does NOT open a panel', async ({ page }) => {
  await expect(page.locator('aside.panel-left.mobile-open')).toHaveCount(0)

  await swipeHorizontal(page, 2)

  // Give any (erroneous) state update a chance to render, then assert nothing opened.
  await page.waitForTimeout(400)
  await expect(page.locator('aside.panel-left.mobile-open')).toHaveCount(0)
  await expect(page.locator('aside.panel-right.mobile-open')).toHaveCount(0)
})
