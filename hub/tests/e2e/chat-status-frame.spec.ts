import { test, expect, type Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'

/* ════════════════════════════════════════════════════════════════════════════
   E2E — the server's `status` progress frame.

   /api/chat now returns its SSE Response BEFORE assembling context, so the
   browser's fetch resolves immediately instead of blocking for the whole
   assembly window (up to the 30s Exa bound in EXA mode). The trade is that the
   assistant bubble exists while the server is still searching, so the server
   narrates the wait with a frame the client renders provisionally:
       data: {"status":"Searching the web and your RxFit records…"}

   That line is PRESENTATION ONLY. It must be overwritten wholesale by the first
   real text frame, must never be appended to, and must never be the thing left
   on screen if the stream ends without an answer — which is the failure the
   empty-answer guard exists to prevent and which a truthy `m.content` would
   otherwise defeat.

   Harness (auth + backend mocks + the task-tap "recall" inject that calls
   sendToApi directly) mirrors chat-error-bubble.spec.ts.
   ════════════════════════════════════════════════════════════════════════════ */

const SECRET = 'playwright-e2e-secret'

/** Google Tasks style due date: local calendar day encoded as UTC midnight. */
function dueForLocalOffset(days: number): string {
  const now = new Date()
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
  const y = local.getFullYear()
  const m = String(local.getMonth() + 1).padStart(2, '0')
  const d = String(local.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}T00:00:00.000Z`
}

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
  await page.route('**/api/paperclip/**', route => route.fulfill({ status: 404, json: { error: 'not found' } }))
  await page.route('**/api/feed**', route => route.fulfill({ json: { feed: [] } }))
  await page.route('**/api/companies**', route => route.fulfill({ json: { companies: [] } }))
  await page.route('**/api/google/chat/**', route => route.fulfill({ json: { spaces: [], messages: [] } }))
  await page.route('**/api/google/calendar**', route => route.fulfill({ json: { events: [] } }))
  await page.route('**/api/google/drive**', route => route.fulfill({ json: { files: [] } }))
  await page.route('**/api/tool-artifacts**', route => route.fulfill({ json: { artifacts: [] } }))

  await page.route('**/api/google/tasks**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('taskListId')) {
      return route.fulfill({
        json: {
          tasks: [{
            id: 'task-1',
            title: 'Pay the vendor invoice',
            status: 'needsAction',
            due: dueForLocalOffset(1),
            notes: 'call vendor first',
            updated: nowIso,
            position: '0001',
          }],
        },
      })
    }
    return route.fulfill({ json: { taskLists: [{ id: 'list-1', title: 'My Tasks', updated: nowIso }] } })
  })
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


const STATUS = 'Searching the web and your RxFit records…'

test('a status frame renders as a progress line, then the answer replaces it', async ({ page }) => {
  await page.route('**/api/chat', route =>
    route.fulfill({
      contentType: 'text/event-stream',
      body:
        `data: ${JSON.stringify({ status: STATUS })}\n\n` +
        `data: ${JSON.stringify({ text: 'GLP-1 trials ' })}\n\n` +
        `data: ${JSON.stringify({ text: 'show sustained loss.' })}\n\n` +
        'data: [DONE]\n\n',
    }),
  )

  const row = page.getByText('Pay the vendor invoice')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()

  const aiBubble = page.locator('.chat-bubble-ai').last()
  await expect(aiBubble).toContainText('GLP-1 trials show sustained loss.', { timeout: 15_000 })

  // Replaced, not appended: the progress line is gone once the answer lands.
  await expect(aiBubble).not.toContainText('Searching the web')

  // Rendered via parseInlineMarkdown's *...* italics, so no stray asterisks or
  // underscores can leak into the bubble as literal characters.
  await expect(aiBubble).not.toContainText('*')
  await expect(aiBubble).not.toContainText('_')
})

test('a stream that ends after only a status frame is not stranded on "Searching…"', async ({ page }) => {
  // The regression a truthy `m.content` would cause: the empty-answer guard tests
  // `!m.content`, and a progress line satisfies it — so without treating the
  // status as emptiness the user would stare at "Searching the web…" forever.
  await page.route('**/api/chat', route =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ status: STATUS })}\n\ndata: [DONE]\n\n`,
    }),
  )

  const row = page.getByText('Pay the vendor invoice')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()

  const aiBubble = page.locator('.chat-bubble-ai').last()
  await expect(aiBubble).toContainText("couldn't generate an answer", { timeout: 15_000 })
  await expect(aiBubble).not.toContainText('Searching the web')
})

test('an error after a status frame replaces it rather than stacking under it', async ({ page }) => {
  // "Searching the web…" left sitting above a ⚠️ reads as though the search is
  // still running behind the failure.
  await page.route('**/api/chat', route =>
    route.fulfill({
      contentType: 'text/event-stream',
      body:
        `data: ${JSON.stringify({ status: STATUS })}\n\n` +
        `data: ${JSON.stringify({ error: 'The AI service is temporarily unavailable.' })}\n\n` +
        'data: [DONE]\n\n',
    }),
  )

  const row = page.getByText('Pay the vendor invoice')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()

  const aiBubble = page.locator('.chat-bubble-ai').last()
  await expect(aiBubble).toContainText('⚠️', { timeout: 15_000 })
  await expect(aiBubble).toContainText('temporarily unavailable')
  await expect(aiBubble).not.toContainText('Searching the web')
})

test('real streamed text is still preserved when an error interrupts mid-stream', async ({ page }) => {
  // The behaviour the status handling must NOT weaken: partial model output is
  // appended to, never discarded (the original reason the error frame appends).
  await page.route('**/api/chat', route =>
    route.fulfill({
      contentType: 'text/event-stream',
      body:
        `data: ${JSON.stringify({ status: STATUS })}\n\n` +
        `data: ${JSON.stringify({ text: 'Partial answer so far.' })}\n\n` +
        `data: ${JSON.stringify({ error: 'Stream interrupted.' })}\n\n` +
        'data: [DONE]\n\n',
    }),
  )

  const row = page.getByText('Pay the vendor invoice')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()

  const aiBubble = page.locator('.chat-bubble-ai').last()
  await expect(aiBubble).toContainText('Partial answer so far.', { timeout: 15_000 })
  await expect(aiBubble).toContainText('⚠️ Stream interrupted.')
  await expect(aiBubble).not.toContainText('Searching the web')
})
