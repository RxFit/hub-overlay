import { test, expect, type Page } from '@playwright/test'
import { encode } from 'next-auth/jwt'

/* ════════════════════════════════════════════════════════════════════════════
   E2E — Google Chat panel: reply-in-thread + app (bot) DMs.

   Two user-visible behaviors shipped together and guarded here:

   1. THREADS. In a named space the flat message page must collapse Google
      Chat-style: a thread renders once (starter + "N replies" chip), replies do
      NOT interleave with unrelated messages, opening the thread shows its
      messages, and the thread composer POSTs with the thread's resource name —
      the payload the server needs to reply INTO the thread instead of starting
      a new one.

   2. APP DMs. A conversation with a Chat app (the Hermes agent) appears in the
      list under Apps once the user's preferences show it, opens like any DM,
      renders the APP badge, and plain sends carry NO thread target.

   Same harness as the sibling specs: real next-auth JWT cookie, every backend
   API mocked at the browser layer. Phone viewport — the bottom nav that opens
   the panel and the single-column panel layout both live at ≤640px.
   ════════════════════════════════════════════════════════════════════════════ */

const SECRET = 'playwright-e2e-secret'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

/** What /api/google/chat/spaces returns (server-annotated, bot DM pre-named). */
const SPACES_PAYLOAD = {
  spaces: [
    {
      name: 'spaces/OPS',
      displayName: 'RxFit Ops',
      type: 'ROOM',
      spaceType: 'SPACE',
      spaceThreadingState: 'THREADED_MESSAGES',
      kind: 'named',
      defaultVisible: true,
    },
    {
      name: 'spaces/HERMES',
      displayName: 'Hermes',
      type: 'DM',
      spaceType: 'DIRECT_MESSAGE',
      spaceThreadingState: 'UNTHREADED_MESSAGES',
      singleUserBotDm: true,
      kind: 'bot',
      defaultVisible: false,
    },
  ],
  // Bot DMs are hidden by default — the user has switched Hermes on.
  preferences: { shown: ['spaces/HERMES'], hidden: [] },
}

const sender = (id: string, displayName: string, type: 'HUMAN' | 'BOT') => ({
  name: `users/${id}`,
  displayName,
  type,
})

/** OPS space page (chronological, as the API route returns it): one thread with a reply, one thread without. */
const OPS_MESSAGES = [
  {
    name: 'spaces/OPS/messages/m1',
    sender: sender('danny', 'Danny', 'HUMAN'),
    createTime: '2026-08-12T14:00:00Z',
    text: 'Shipping the new screening flow today',
    thread: { name: 'spaces/OPS/threads/T1' },
  },
  {
    name: 'spaces/OPS/messages/m2',
    sender: sender('hermes', 'Hermes', 'BOT'),
    createTime: '2026-08-12T14:05:00Z',
    text: 'Deploy pipeline is green',
    thread: { name: 'spaces/OPS/threads/T1' },
    threadReply: true,
  },
  {
    name: 'spaces/OPS/messages/m3',
    sender: sender('alex', 'Alex', 'HUMAN'),
    createTime: '2026-08-12T14:10:00Z',
    text: 'Standup moved to 3pm',
    thread: { name: 'spaces/OPS/threads/T2' },
  },
]

const HERMES_MESSAGES = [
  {
    name: 'spaces/HERMES/messages/h1',
    sender: sender('danny', 'Danny', 'HUMAN'),
    createTime: '2026-08-12T15:00:00Z',
    text: 'Hermes, summarize today',
    thread: { name: 'spaces/HERMES/threads/H1' },
  },
  {
    name: 'spaces/HERMES/messages/h2',
    sender: sender('app', 'Hermes', 'BOT'),
    createTime: '2026-08-12T15:01:00Z',
    text: '3 new leads came in via the site',
    thread: { name: 'spaces/HERMES/threads/H2' },
  },
]

async function mockBackend(page: Page) {
  const nowIso = new Date().toISOString()

  // Catch-all FIRST (the most recently registered route wins in Playwright).
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
  await page.route('**/api/tool-artifacts**', route => route.fulfill({ json: { artifacts: [] } }))

  // Google Chat mocks — specific enough to serve the panel's whole lifecycle.
  await page.route('**/api/google/chat/spaces**', route => route.fulfill({ json: SPACES_PAYLOAD }))
  await page.route('**/api/google/chat/members**', route => route.fulfill({ json: { members: [] } }))
  await page.route('**/api/google/chat/unread**', route => route.fulfill({ json: { unread: {}, total: 0 } }))
  await page.route('**/api/google/chat/readstate**', route => route.fulfill({ json: {} }))
  await page.route('**/api/google/chat/messages**', route => {
    const req = route.request()
    if (req.method() === 'POST') {
      return route.fulfill({ json: { message: { name: 'spaces/X/messages/new' } } })
    }
    const url = new URL(req.url())
    const spaceId = url.searchParams.get('spaceId')
    const threadName = url.searchParams.get('threadName')
    if (threadName === 'spaces/OPS/threads/T1') {
      return route.fulfill({ json: { messages: OPS_MESSAGES.filter(m => m.thread.name === threadName) } })
    }
    if (spaceId === 'spaces/HERMES') {
      return route.fulfill({ json: { messages: HERMES_MESSAGES } })
    }
    return route.fulfill({ json: { messages: OPS_MESSAGES } })
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

  // Open the Google Chat panel from the bottom nav and enter the Ops space.
  await page.getByRole('tab', { name: /Google Chat/ }).tap()
  await expect(page.getByRole('option', { name: /RxFit Ops/ })).toBeVisible({ timeout: 15_000 })
})

test('threads collapse in the space view and a thread reply POSTs the thread name', async ({ page }) => {
  await page.getByRole('option', { name: /RxFit Ops/ }).tap()

  // Space view: both thread starters visible…
  await expect(page.getByText('Shipping the new screening flow today')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Standup moved to 3pm')).toBeVisible()
  // …but the reply is COLLAPSED behind the chip, not interleaved.
  await expect(page.getByText('Deploy pipeline is green')).toBeHidden()
  const chip = page.getByRole('button', { name: /Open thread — 1 reply/ })
  await expect(chip).toBeVisible()

  // Open the thread: starter + divider + the reply, and a thread composer.
  await chip.tap()
  await expect(page.getByText('Deploy pipeline is green')).toBeVisible()
  await expect(page.getByText('Shipping the new screening flow today')).toBeVisible()

  const replyBox = page.getByPlaceholder('Reply in thread…')
  await expect(replyBox).toBeVisible()
  await replyBox.fill('Sounds good — following up from the HUB')

  // The send must carry the THREAD resource name (server relays it to Google
  // with messageReplyOption so the reply lands inside T1, not a new thread).
  const [postReq] = await Promise.all([
    page.waitForRequest(r => r.method() === 'POST' && r.url().includes('/api/google/chat/messages')),
    page.getByRole('button', { name: 'Send reply' }).tap(),
  ])
  expect(postReq.postDataJSON()).toMatchObject({
    spaceId: 'spaces/OPS',
    text: 'Sounds good — following up from the HUB',
    threadName: 'spaces/OPS/threads/T1',
  })

  // Back returns to the space conversation with the chip still in place.
  await page.getByRole('button', { name: 'Back to conversation' }).tap()
  await expect(page.getByRole('button', { name: /Open thread — 1 reply/ })).toBeVisible()
})

test('an app DM (Hermes) is listed under Apps, renders the APP badge, and plain sends carry no thread target', async ({ page }) => {
  // The Apps section exists and holds the Hermes conversation.
  await expect(page.locator('.chat-space-section__label', { hasText: 'Apps' })).toBeVisible()
  await page.getByRole('option', { name: /Hermes/ }).tap()

  // Both sides of the conversation render; the bot sender is badged APP.
  await expect(page.getByText('Hermes, summarize today')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('3 new leads came in via the site')).toBeVisible()
  await expect(page.locator('.chat-msg__app-badge').first()).toBeVisible()

  // A DM is flat — no reply-in-thread affordance anywhere.
  await expect(page.getByRole('button', { name: /Open thread/ })).toHaveCount(0)

  const composer = page.getByPlaceholder(/Message Hermes/)
  await composer.fill('status?')
  // Scope to the panel dialog — the AI assistant behind it has its own
  // "Send message" button.
  const panel = page.getByRole('dialog', { name: 'Google Chat' })
  const [postReq] = await Promise.all([
    page.waitForRequest(r => r.method() === 'POST' && r.url().includes('/api/google/chat/messages')),
    panel.getByRole('button', { name: 'Send message' }).tap(),
  ])
  const body = postReq.postDataJSON()
  expect(body).toMatchObject({ spaceId: 'spaces/HERMES', text: 'status?' })
  expect(body.threadName).toBeUndefined()
  expect(body.threadKey).toBeUndefined()
})
