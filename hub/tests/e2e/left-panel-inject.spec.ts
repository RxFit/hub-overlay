import { test, expect, type Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'

/* ════════════════════════════════════════════════════════════════════════════
   E2E — left panel → AI chat connections, through the real DOM.

   The source-level wiring guard (tests/left-panel-inject-wiring.test.ts)
   asserts the components reference the inject builders; these tests go one
   step further and click the actual rendered rows, then assert the exact
   network payloads the UI emits — the same class of regression the monolith
   extraction caused (taps silently losing their attachments) fails here even
   if it survives every unit test.

   Auth: a genuine next-auth JWT cookie is minted with the dev server's
   NEXTAUTH_SECRET so the middleware passes. Every backend API is mocked at
   the browser layer with page.route — no Google/DB/model credentials needed.
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

function todayAt(hour: number): Date {
  const d = new Date()
  d.setHours(hour, 0, 0, 0)
  return d
}

async function mockBackend(page: Page) {
  const nowIso = new Date().toISOString()
  const eventStart = todayAt(9)
  const eventEnd = todayAt(10)

  // Catch-all FIRST (Playwright matches the most recently registered route
  // first, so the specific handlers below take precedence).
  await page.route('**/api/**', route =>
    route.fulfill({ json: {} }),
  )

  await page.route('**/api/auth/session', route =>
    route.fulfill({
      json: {
        user: {
          name: 'Test User',
          email: 'danny@rxfitatx.com',
          role: 'admin',
          assignedProjects: ['*'],
        },
        expires: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }),
  )

  await page.route('**/api/kpis**', route => route.fulfill({ json: { kpis: [], projects: [] } }))
  // ceo-pulse must carry `departments` — a bare {} crashes BusinessManagerPanel
  // (pulse?.departments.find). A 404 keeps pulse null, which the panel handles.
  await page.route('**/api/paperclip/**', route =>
    route.fulfill({ status: 404, json: { error: 'not found' } }),
  )
  await page.route('**/api/feed**', route => route.fulfill({ json: { feed: [] } }))
  await page.route('**/api/companies**', route => route.fulfill({ json: { companies: [] } }))
  await page.route('**/api/google/chat/**', route => route.fulfill({ json: { spaces: [], messages: [] } }))

  await page.route('**/api/google/tasks**', route => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'POST') {
      return route.fulfill({ json: { task: { id: 'task-1' } } })
    }
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
    return route.fulfill({
      json: { taskLists: [{ id: 'list-1', title: 'My Tasks', updated: nowIso }] },
    })
  })

  await page.route('**/api/google/calendar**', route => {
    if (route.request().method() === 'DELETE') {
      return route.fulfill({ json: { success: true } })
    }
    return route.fulfill({
      json: {
        events: [{
          id: 'evt-1',
          summary: 'Client sync',
          description: 'quarterly review',
          start: { dateTime: eventStart.toISOString() },
          end: { dateTime: eventEnd.toISOString() },
          htmlLink: '',
          status: 'confirmed',
          location: 'Zoom',
          attendees: [{ email: 'a@x.com' }, { email: 'b@x.com' }],
          calendarId: 'work-cal',
        }],
      },
    })
  })

  await page.route('**/api/google/drive**', route => {
    const url = new URL(route.request().url())
    const isTranscripts = url.searchParams.get('filter') === 'transcripts'
    return route.fulfill({
      json: {
        files: [isTranscripts
          ? { id: 'file-2', name: 'Standup 7/2', mimeType: 'application/vnd.google-apps.document', modifiedTime: nowIso }
          : { id: 'file-1', name: 'Q3 Plan', mimeType: 'application/pdf', modifiedTime: nowIso }],
      },
    })
  })

  await page.route('**/api/tool-artifacts**', route =>
    route.fulfill({
      json: {
        artifacts: [{
          id: 'art-1',
          toolId: 'decision-memo',
          title: 'Pricing Memo',
          content: {},
          contextSummary: null,
          status: 'completed',
          createdBy: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        }],
      },
    }),
  )

  await page.route('**/api/chat', route =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"text":"ok"}\n\ndata: [DONE]\n\n',
    }),
  )
}

/** Click something and capture the JSON body of the /api/chat POST it fires. */
async function captureChatPost(page: Page, action: () => Promise<void>) {
  const reqPromise = page.waitForRequest(
    r => r.url().includes('/api/chat') && r.method() === 'POST',
    { timeout: 15_000 },
  )
  await action()
  const req = await reqPromise
  return req.postDataJSON() as {
    messages: { role: string; content: string }[]
    attachments?: { id: string; type: string; label: string; fileId?: string; content?: string; mimeType?: string }[]
    useCase: string
  }
}

/**
 * Expand a collapsible left-panel section by title, tolerating either default
 * state — the header button toggles, so clicking an already-open section would
 * close it.
 */
async function expandSection(page: Page, title: RegExp) {
  const header = page.getByRole('button', { name: title })
  await expect(header).toBeVisible({ timeout: 30_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') {
    await header.click()
  }
}

test.beforeEach(async ({ page, context, baseURL }) => {
  const sessionToken = await encode({
    token: {
      name: 'Test User',
      email: 'danny@rxfitatx.com',
      sub: 'test-user',
      role: 'admin',
      assignedProjects: ['*'],
      accessToken: 'fake-access-token',
    },
    secret: SECRET,
  })
  await context.addCookies([{
    name: 'next-auth.session-token',
    value: sessionToken,
    url: baseURL!,
    httpOnly: true,
    sameSite: 'Lax',
  }])

  await mockBackend(page)
  // Pre-dismiss the first-run onboarding modal: it opens during the pre-session-
  // hydration window (role defaults to 'onboarding') and intercepts all clicks.
  await page.addInitScript(() => localStorage.setItem('hub-onboarded', '1'))
  await page.goto('/', { timeout: 80_000 })
  // Left panel rendered = middleware passed + session hydrated.
  await expect(page.getByRole('heading', { name: 'AI Assistant' })).toBeVisible({ timeout: 60_000 })
})

test('task tap injects the builder message and the row shows a future-aware due date', async ({ page }) => {
  const row = page.getByText('Pay the vendor invoice')
  await expect(row).toBeVisible({ timeout: 30_000 })
  // formatDueDate regression check: a task due tomorrow must NOT read "just now".
  await expect(page.getByText('Due Tomorrow')).toBeVisible()

  const body = await captureChatPost(page, () => row.click())
  const msg = body.messages[body.messages.length - 1].content
  expect(msg).toContain('Tell me about this task from my "My Tasks" list')
  expect(msg).toContain('• Title: Pay the vendor invoice')
  expect(msg).toContain('• Status: Pending')
  expect(msg).toContain('• Due: Tomorrow')
  expect(msg).toContain('• Notes: call vendor first')
  expect(body.useCase).toBe('recall')
})

test('calendar event tap injects the builder message with end time and attendees', async ({ page }) => {
  const row = page.getByRole('button', { name: /Event: Client sync/ })
  await expect(row).toBeVisible({ timeout: 30_000 })

  const body = await captureChatPost(page, () => row.click())
  const msg = body.messages[body.messages.length - 1].content
  expect(msg).toContain('• Title: Client sync')
  expect(msg).toContain('• When: Today at')
  expect(msg).toContain(', ends ')
  expect(msg).toContain('• Location: Zoom')
  expect(msg).toContain('• Attendees: a@x.com, b@x.com')
  expect(msg).toContain('• Details: quarterly review')
})

test('calendar delete sends the event source calendarId', async ({ page }) => {
  await expect(page.getByRole('button', { name: /Event: Client sync/ })).toBeVisible({ timeout: 30_000 })

  const deletePromise = page.waitForRequest(
    r => r.url().includes('/api/google/calendar') && r.method() === 'DELETE',
    { timeout: 15_000 },
  )
  // The delete button is hover-revealed; force the click.
  await page.getByRole('button', { name: 'Delete event: Client sync' }).click({ force: true })
  await page.getByRole('button', { name: 'Delete Event', exact: true }).click()

  const body = (await deletePromise).postDataJSON() as { eventId: string; calendarId?: string }
  expect(body.eventId).toBe('evt-1')
  expect(body.calendarId).toBe('work-cal')
})

test('document tap attaches the real Drive fileId', async ({ page }) => {
  await expandSection(page, /Documents/)
  const row = page.getByRole('listitem', { name: /Document: Q3 Plan/ })
  await expect(row).toBeVisible({ timeout: 30_000 })

  const body = await captureChatPost(page, () => row.click())
  const msg = body.messages[body.messages.length - 1].content
  expect(msg).toContain('Tell me about the document "Q3 Plan"')
  expect(body.attachments).toHaveLength(1)
  expect(body.attachments![0]).toMatchObject({
    type: 'document',
    fileId: 'file-1',
    label: 'Q3 Plan',
    mimeType: 'application/pdf',
  })
})

test('transcript tap uses the summarize prompt and attaches the fileId', async ({ page }) => {
  await expandSection(page, /Documents/)
  await page.getByRole('tab', { name: 'Transcripts' }).click()
  const row = page.getByRole('listitem', { name: /Document: Standup 7\/2/ })
  await expect(row).toBeVisible({ timeout: 30_000 })

  const body = await captureChatPost(page, () => row.click())
  const msg = body.messages[body.messages.length - 1].content
  expect(msg).toContain('Summarize the meeting transcript "Standup 7/2"')
  expect(body.attachments![0].fileId).toBe('file-2')
})

test('artifact tap attaches the resolvable [artifact:id] marker', async ({ page }) => {
  await expandSection(page, /Documents/)
  await page.getByRole('tab', { name: 'Artifacts' }).click()
  const row = page.getByRole('listitem', { name: 'Artifact: Pricing Memo' })
  await expect(row).toBeVisible({ timeout: 30_000 })

  const body = await captureChatPost(page, () => row.click())
  const msg = body.messages[body.messages.length - 1].content
  expect(msg).toBe('Show me the decision-memo artifact: Pricing Memo')
  expect(body.attachments).toHaveLength(1)
  expect(body.attachments![0].content).toContain('[artifact:art-1]')
})
