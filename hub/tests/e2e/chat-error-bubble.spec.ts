import { test, expect, type Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'

/* ════════════════════════════════════════════════════════════════════════════
   E2E — provider-outage error surfaces render the friendly ⚠️ bubble.

   Guards the EXACT surface from the reported production bug: when the model
   provider is misconfigured/unavailable, route.ts catches the error, maps it via
   friendlyModelError, and emits it as an SSE error frame:
       data: {"error":"<friendly message>"}\n\n
       data: [DONE]\n\n
   useChatEngine.sendToApi turns `parsed.error` into an assistant bubble whose
   content is `⚠️ ${error}` (see the setMessages branch on `parsed.error`). This
   test asserts that friendly copy renders, so a rendering regression can't
   silently swallow the outage message.

   A second case covers the non-streamed failure path: a 500 JSON response makes
   `res.ok` false, so sendToApi throws and resolveChatError renders the generic
   "Something went wrong on my end." bubble (verified against useChatEngine.ts).

   Auth + backend mocks mirror left-panel-inject.spec.ts. The task-tap ("recall")
   inject is the trigger — it calls sendToApi directly (no Interview Mode gate),
   which is the same code path a typed question takes to reach the chat API.
   ════════════════════════════════════════════════════════════════════════════ */

const SECRET = 'playwright-e2e-secret'

// The exact friendly copy the provider-outage path surfaces (matches the
// screenshot bug): a provider-configuration outage message.
const PROVIDER_OUTAGE_MSG =
  'The AI service is temporarily unavailable (provider configuration). Please try again shortly — if it persists, contact an administrator.'

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

test('a provider-outage SSE error frame renders the friendly ⚠️ bubble', async ({ page }) => {
  // The real outage path: streamChat throws → route.ts emits an error frame with
  // friendlyModelError's copy, then [DONE]. Match that wire format exactly.
  await page.route('**/api/chat', route =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ error: PROVIDER_OUTAGE_MSG })}\n\ndata: [DONE]\n\n`,
    }),
  )

  const row = page.getByText('Pay the vendor invoice')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()

  // useChatEngine renders `⚠️ ${parsed.error}` into the assistant bubble.
  const aiBubble = page.locator('.chat-bubble-ai').last()
  await expect(aiBubble).toContainText('⚠️', { timeout: 15_000 })
  await expect(aiBubble).toContainText('temporarily unavailable (provider configuration)')
})

test('a 500 response renders the generic "Something went wrong" bubble', async ({ page }) => {
  // Non-streamed failure: an HTTP 500 makes res.ok false, so sendToApi throws and
  // resolveChatError() supplies the generic fallback copy (verified in
  // useChatEngine.ts). A dev-only diagnostic suffix may follow, so assert only
  // the stable user-facing prefix.
  await page.route('**/api/chat', route =>
    route.fulfill({ status: 500, json: { error: 'Internal Server Error' } }),
  )

  const row = page.getByText('Pay the vendor invoice')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()

  const aiBubble = page.locator('.chat-bubble-ai').last()
  await expect(aiBubble).toContainText('Something went wrong on my end', { timeout: 15_000 })
})
