import { test, expect, type Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'

/* ════════════════════════════════════════════════════════════════════════════
   E2E — Interview Mode → quality gate → ActionConfirmCard → execute.

   The full action pipeline, driven through the real UI with every backend
   mocked at the browser layer:

     type request → /api/chat/detect-intent (intent + entities)
       → Interview Mode Q&A → /api/chat/score-context (score + gateToken)
       → ActionConfirmCard renders → Approve
       → executeAction (GET task lists → POST create) → "Task created!"

   Covered roles: admin (baseline) AND onboarding — the Carol-Jean case where
   pending users must be able to run personal Google actions, and must get a
   clear Permission Denied for org-level intents (send_gmail). Also pins the
   new 413/429 chat error copy end-to-end.
   ════════════════════════════════════════════════════════════════════════════ */

const SECRET = 'playwright-e2e-secret'
const nowIso = new Date().toISOString()

const captured: { taskPosts: any[] } = { taskPosts: [] }

async function mockBackend(page: Page, role: 'admin' | 'onboarding', intent: string | null, entities: Record<string, string> = {}) {
  await page.route('**/api/**', route => route.fulfill({ json: {} }))

  await page.route('**/api/auth/session', route =>
    route.fulfill({
      json: {
        user: { name: 'Carol-Jean', email: 'caroljean37@gmail.com', role, assignedProjects: [] },
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
  await page.route('**/api/google/chat/**', route => route.fulfill({ json: { spaces: [], messages: [], unread: {}, total: 0 } }))
  await page.route('**/api/google/calendar**', route => route.fulfill({ json: { events: [] } }))
  await page.route('**/api/google/drive**', route => route.fulfill({ json: { files: [] } }))

  await page.route('**/api/chat/detect-intent', route =>
    route.fulfill({ json: { intent, extractedEntities: entities } }),
  )
  await page.route('**/api/chat/score-context', route =>
    route.fulfill({ json: { score: 92, passed: true, weakDimension: null, followUpQuestion: null, gateToken: 'gate-tok-1' } }),
  )

  await page.route('**/api/google/tasks**', route => {
    if (route.request().method() === 'POST') {
      captured.taskPosts.push(route.request().postDataJSON())
      return route.fulfill({ json: { task: { id: 'new-task', title: route.request().postDataJSON()?.title } } })
    }
    return route.fulfill({ json: { taskLists: [{ id: 'list-1', title: 'My Tasks', updated: nowIso }] } })
  })
}

async function boot(page: Page, context: any, baseURL: string, role: 'admin' | 'onboarding', intent: string | null, entities: Record<string, string> = {}) {
  captured.taskPosts.length = 0
  const sessionToken = await encode({
    token: {
      name: 'Carol-Jean', email: 'caroljean37@gmail.com', sub: 'test-user',
      role, assignedProjects: [], accessToken: 'fake-access-token',
    },
    secret: SECRET,
  })
  await context.addCookies([{
    name: 'next-auth.session-token', value: sessionToken, url: baseURL,
    httpOnly: true, sameSite: 'Lax',
  }])
  await mockBackend(page, role, intent, entities)
  await page.addInitScript(() => localStorage.setItem('hub-onboarded', '1'))
  await page.goto('/', { timeout: 80_000 })
  await expect(page.getByRole('heading', { name: 'AI Assistant' })).toBeVisible({ timeout: 60_000 })
}

async function sendChat(page: Page, text: string) {
  const input = page.getByLabel('Chat message input')
  await input.fill(text)
  await page.getByLabel('Send message').click()
}

/** Drive create_task (description pre-extracted) through confirm → card → approve. */
async function runCreateTaskFlow(page: Page) {
  await sendChat(page, 'add a task to follow up with the vendor')

  // create_task is a personal action → the lightweight single "add any more
  // context?" question (no multi-step Interview Mode ceremony).
  await expect(page.getByText('add any more context to define this task')).toBeVisible({ timeout: 15_000 })

  // Answer the single context question (a "go ahead"-style skip proceeds).
  await sendChat(page, 'yes')

  // Quality gate passes → scaffold + ActionConfirmCard.
  await expect(page.getByText('review the action below')).toBeVisible({ timeout: 20_000 })
  const approve = page.getByRole('button', { name: 'Approve action' })
  await expect(approve).toBeVisible({ timeout: 10_000 })
  await approve.click()

  // executeAction ran: lists fetched, task POSTed, success bubble rendered.
  await expect(page.getByText('Task created!')).toBeVisible({ timeout: 15_000 })
  expect(captured.taskPosts[0]).toMatchObject({
    action: 'create',
    taskListId: 'list-1',
    title: 'follow up with the vendor',
  })
}

test('admin: create_task interview → confirm card → approve → task POSTed', async ({ page, context, baseURL }) => {
  await boot(page, context, baseURL!, 'admin', 'create_task', { description: 'follow up with the vendor' })
  await runCreateTaskFlow(page)
})

test('onboarding (Carol-Jean): the same personal create_task flow works end-to-end', async ({ page, context, baseURL }) => {
  await boot(page, context, baseURL!, 'onboarding', 'create_task', { description: 'follow up with the vendor' })
  await runCreateTaskFlow(page)

  // Interview turns are served by the basic-functionality model tier.
  await expect(page.locator('.chat-header-model-badge')).toHaveText('Gemini 3.5 Flash')
})

test('onboarding: an org-level intent (send_gmail) gets a clear Permission Denied', async ({ page, context, baseURL }) => {
  await boot(page, context, baseURL!, 'onboarding', 'send_gmail', { to: 'x@y.com', subject: 'hi', body: 'hello' })
  await sendChat(page, 'email maria that the invoice is paid')

  const denial = page.getByText('Permission Denied')
  await expect(denial).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/requires\s+\**staff\**/i)).toBeVisible()
  // No confirm card, no task write.
  await expect(page.getByRole('button', { name: 'Approve action' })).toHaveCount(0)
})

test('413 and 429 chat errors render their specific actionable copy', async ({ page, context, baseURL }) => {
  await boot(page, context, baseURL!, 'admin', null) // no intent → plain sendToApi

  await page.route('**/api/chat', route =>
    route.fulfill({ status: 413, json: { error: 'Request too large' } }),
  )
  await sendChat(page, 'summarize this giant conversation')
  await expect(page.getByText('This conversation has grown too large to send')).toBeVisible({ timeout: 15_000 })

  await page.route('**/api/chat', route =>
    route.fulfill({ status: 429, json: { error: 'Too many requests — please slow down.' } }),
  )
  await sendChat(page, 'and again')
  await expect(page.getByText(/sending messages a little too quickly/)).toBeVisible({ timeout: 15_000 })
})
