import { test, expect, type Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'

/* ════════════════════════════════════════════════════════════════════════════
   E2E — Gmail overlay feature wiring: Focus strip, pagination, action sheet,
   and the Google Chat mark-read write.

   Drives the REAL rendered overlay (header Google Chat button → Gmail/Chat
   tabs) with every backend mocked at the browser layer, and asserts both the
   visible outcomes (strip cards, appended rows, toast) and the exact wire
   requests the UI emits (pageToken cursor, trash POST body, readstate POST).
   ════════════════════════════════════════════════════════════════════════════ */

const SECRET = 'playwright-e2e-secret'

const nowIso = new Date().toISOString()

const PAGE1_THREADS = [
  { id: 't1', subject: 'Quarterly numbers', from: 'Sarah Allen <sarah@example.com>', date: nowIso, snippet: 'Can you review before Friday?', isUnread: true, messageCount: 3 },
  { id: 't2', subject: 'Team offsite', from: 'Bob Ray <bob@example.com>', date: nowIso, snippet: 'Venue options attached', isUnread: true, messageCount: 1 },
]
const PAGE2_THREADS = [
  { id: 't3', subject: 'Old newsletter', from: 'News <no-reply@news.example.com>', date: nowIso, snippet: 'Last month in fitness', isUnread: false, messageCount: 1 },
]

async function mockBackend(page: Page, captured: { gmailGets: string[]; posts: { url: string; body: any }[] }) {
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
  // 404 (not {}) so panels that fetch these take their error path instead of
  // crashing on missing fields (BusinessManagerPanel reads pulse.departments).
  await page.route('**/api/paperclip/**', route => route.fulfill({ status: 404, json: { error: 'not found' } }))
  await page.route('**/api/orgs**', route => route.fulfill({ status: 404, json: { error: 'not found' } }))
  await page.route('**/api/feed**', route => route.fulfill({ json: { feed: [] } }))
  await page.route('**/api/companies**', route => route.fulfill({ json: { companies: [] } }))
  await page.route('**/api/google/tasks**', route => route.fulfill({ json: { taskLists: [] } }))
  await page.route('**/api/google/calendar**', route => route.fulfill({ json: { events: [] } }))
  await page.route('**/api/google/drive**', route => route.fulfill({ json: { files: [] } }))

  /* ── Google Chat (overlay Chat tab) ── */
  await page.route('**/api/google/chat/spaces', route =>
    route.fulfill({ json: { spaces: [{ name: 'spaces/AAA', displayName: 'RxFit Ops', type: 'ROOM' }] } }),
  )
  await page.route('**/api/google/chat/messages**', route =>
    route.fulfill({
      json: {
        messages: [{
          name: 'spaces/AAA/messages/m1',
          sender: { name: 'users/1', displayName: 'Maria' },
          createTime: nowIso,
          text: 'The demo moved to 3pm',
        }],
      },
    }),
  )
  await page.route('**/api/google/chat/unread**', route =>
    route.fulfill({ json: { unread: { 'spaces/AAA': 2 }, total: 2 } }),
  )
  await page.route('**/api/google/chat/members**', route => route.fulfill({ json: { members: [] } }))
  await page.route('**/api/google/chat/readstate', route => {
    captured.posts.push({ url: route.request().url(), body: route.request().postDataJSON() })
    return route.fulfill({ json: { spaceId: 'spaces/AAA', lastReadTime: nowIso } })
  })

  // ── Gmail: paginated inbox first, then the more-specific focus/actions
  // handlers (Playwright matches the MOST RECENTLY registered route first, so
  // these must come after the broad gmail glob or it shadows them). ──
  const trashed = new Set<string>()
  await page.route('**/api/google/gmail**', route => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET') return route.fulfill({ json: {} })
    captured.gmailGets.push(url.search)
    if (url.searchParams.get('threadId')) {
      return route.fulfill({ json: { thread: { id: url.searchParams.get('threadId'), messages: [] } } })
    }
    const pageToken = url.searchParams.get('pageToken')
    if (pageToken === 'tok-2') {
      return route.fulfill({ json: { threads: PAGE2_THREADS.filter(t => !trashed.has(t.id)), unreadCount: 0, nextPageToken: null } })
    }
    return route.fulfill({ json: { threads: PAGE1_THREADS.filter(t => !trashed.has(t.id)), unreadCount: 2, nextPageToken: 'tok-2' } })
  })
  await page.route('**/api/google/gmail/focus**', route =>
    route.fulfill({
      json: {
        items: [{ id: 't1', priority: 95, reason: 'Sarah is waiting on your review', action: 'reply' }],
        generatedAt: nowIso,
        cached: false,
      },
    }),
  )
  await page.route('**/api/google/gmail/actions', route => {
    const body = route.request().postDataJSON()
    captured.posts.push({ url: route.request().url(), body })
    if (body?.action === 'trash' && body?.threadId) trashed.add(body.threadId)
    return route.fulfill({ json: { ok: true } })
  })
}

async function openGmailTab(page: Page) {
  await page.getByRole('button', { name: 'Google Chat' }).click()
  await page.getByRole('button', { name: /^Gmail/ }).click()
  // Scope to the LIST row — the subject also appears inside a Focus card.
  await expect(page.locator('.gmail-list-item__subject', { hasText: 'Quarterly numbers' })).toBeVisible({ timeout: 30_000 })
}

const captured: { gmailGets: string[]; posts: { url: string; body: any }[] } = { gmailGets: [], posts: [] }

test.beforeEach(async ({ page, context, baseURL }) => {
  captured.gmailGets.length = 0
  captured.posts.length = 0

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

  await mockBackend(page, captured)
  await page.addInitScript(() => localStorage.setItem('hub-onboarded', '1'))
  await page.goto('/', { timeout: 80_000 })
  await expect(page.getByRole('heading', { name: 'AI Assistant' })).toBeVisible({ timeout: 60_000 })
})

test('the Focus strip renders ranked cards from live thread data', async ({ page }) => {
  await openGmailTab(page)

  const strip = page.locator('.gmail-focus')
  await expect(strip).toBeVisible({ timeout: 15_000 })
  // Card content joins the ranked item with the LIVE thread (sender + reason).
  await expect(strip.getByText('Sarah Allen')).toBeVisible()
  await expect(strip.getByText('Sarah is waiting on your review')).toBeVisible()
})

test('Load older emails appends the next Gmail page and stops at the end', async ({ page }) => {
  await openGmailTab(page)

  const loadMore = page.getByRole('button', { name: 'Load older emails' })
  await expect(loadMore).toBeVisible({ timeout: 15_000 })
  await loadMore.click()

  // Page-2 rows appear under the first page; button disappears (no more pages).
  await expect(page.locator('.gmail-list-item__subject', { hasText: 'Old newsletter' })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.gmail-list-item__subject', { hasText: 'Quarterly numbers' })).toBeVisible()
  await expect(loadMore).toHaveCount(0)

  // The UI sent Gmail's cursor on the wire.
  expect(captured.gmailGets.some(q => q.includes('pageToken=tok-2'))).toBe(true)
})

test('right-click action sheet: two-tap delete trashes the thread and toasts', async ({ page }) => {
  await openGmailTab(page)

  await page.getByText('Team offsite').click({ button: 'right' })
  const sheet = page.getByRole('dialog', { name: /Actions for email from/ })
  await expect(sheet).toBeVisible({ timeout: 10_000 })

  // The sheet swallows clicks for its 300ms ghost-click grace window (long-press
  // protection) — wait it out before the first real tap.
  await page.waitForTimeout(400)

  // Two-tap confirm: first tap arms, second executes.
  await sheet.getByText('Delete (move to Trash)').click()
  await sheet.getByText('Tap again to confirm delete').click()

  // Optimistic removal + toast; the wire call carries the right action + id.
  await expect(page.getByText('Moved to Trash')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Team offsite')).toHaveCount(0)
  const trashPost = captured.posts.find(p => p.url.includes('/api/google/gmail/actions'))
  expect(trashPost?.body).toMatchObject({ action: 'trash', threadId: 't2' })
})

test('opening a Chat space marks it read (readstate POST fires)', async ({ page }) => {
  await page.getByRole('button', { name: 'Google Chat' }).click()

  // Chat tab is the default — open the space with unread messages.
  await page.getByText('RxFit Ops').first().click()
  await expect(page.getByText('The demo moved to 3pm')).toBeVisible({ timeout: 15_000 })

  // Viewing the thread fires the mark-read write with the space id.
  await expect.poll(
    () => captured.posts.find(p => p.url.includes('/api/google/chat/readstate'))?.body,
    { timeout: 10_000 },
  ).toMatchObject({ spaceId: 'spaces/AAA' })
})
