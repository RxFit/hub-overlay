import { test, expect, type Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'

/* ════════════════════════════════════════════════════════════════════════════
   E2E — AI chat happy path: a streamed answer actually RENDERS in the bubble.

   left-panel-inject.spec.ts proves the UI emits the right /api/chat POST, but it
   never asserts the streamed reply reaches the screen — a regression in the SSE
   parser (useChatEngine.sendToApi) or the message renderer (MessageContent) would
   sail past it. This test mocks /api/chat with a real multi-frame SSE body and
   asserts the assistant bubble shows the concatenated text.

   The SSE wire format is exactly what app/api/chat/route.ts emits:
     data: {"text":"<chunk>"}\n\n   (one frame per model chunk)
     data: [DONE]\n\n               (terminal)
   and useChatEngine appends each `parsed.text` into the assistant bubble.

   The task-tap ("recall") inject is reused as the trigger: it calls sendToApi
   directly (no intent detection / Interview Mode gate), so the mocked stream
   renders as a plain assistant answer.

   Auth: a genuine next-auth JWT cookie is minted with the dev server's
   NEXTAUTH_SECRET so the middleware passes. Every backend API is mocked at the
   browser layer with page.route — no Google/DB/model credentials needed.
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

  // Catch-all FIRST (Playwright matches the most recently registered route
  // first, so the specific handlers below take precedence).
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
  // Pre-dismiss the first-run onboarding modal so it doesn't intercept clicks.
  await page.addInitScript(() => localStorage.setItem('hub-onboarded', '1'))
  await page.goto('/', { timeout: 80_000 })
  await expect(page.getByRole('heading', { name: 'AI Assistant' })).toBeVisible({ timeout: 60_000 })
})

test('a streamed multi-frame SSE answer renders in the assistant bubble', async ({ page }) => {
  // Mock /api/chat with a real SSE stream (registered AFTER mockBackend, so it
  // takes precedence). Two text frames + terminal [DONE] — the exact frame shape
  // route.ts emits (`data: {"text":...}\n\n` per chunk, `data: [DONE]\n\n` last).
  await page.route('**/api/chat', route =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"text":"Hello "}\n\ndata: {"text":"world"}\n\ndata: [DONE]\n\n',
    }),
  )

  // Tap the task row — the "recall" inject calls sendToApi directly, so the reply
  // streams straight into an assistant bubble (no Interview Mode gate).
  const row = page.getByText('Pay the vendor invoice')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()

  // The assistant bubble renders the concatenated streamed text.
  const aiBubble = page.locator('.chat-bubble-ai').last()
  await expect(aiBubble).toContainText('Hello world', { timeout: 15_000 })
})

test('the header model badge shows the SSE-announced model and updates per turn', async ({ page }) => {
  // Turn 1: the server announces Gemini 2.5 Flash via the modelUsed frame —
  // the exact frame streamModelResponse emits before the first text chunk.
  await page.route('**/api/chat', route =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"modelUsed":"Gemini 2.5 Flash"}\n\ndata: {"text":"answer one"}\n\ndata: [DONE]\n\n',
    }),
  )

  const badge = page.locator('.chat-header-model-badge')
  await expect(badge).toHaveText('AI') // neutral before any request

  const row = page.getByText('Pay the vendor invoice')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()

  await expect(badge).toHaveText('Gemini 2.5 Flash', { timeout: 15_000 })

  // Turn 2: a different provider answers — the badge must FOLLOW the new
  // frame, not stick to the previous turn's model (the staleness bug class:
  // sendToApi resets the badge on every request; only server frames set it).
  await page.route('**/api/chat', route =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"modelUsed":"Claude Fable 5"}\n\ndata: {"text":"answer two"}\n\ndata: [DONE]\n\n',
    }),
  )
  const input = page.getByLabel('Chat message input')
  await input.fill('follow up question')
  await page.getByLabel('Send message').click()

  await expect(badge).toHaveText('Claude Fable 5', { timeout: 15_000 })
})
