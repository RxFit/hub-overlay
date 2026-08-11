import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/google/gmail/focus — the AI-ranked Focus queue.

   Mocking boundary: auth (session + Google token), the Gmail thread fetch, the
   Gemini and Claude calls, and the audit sink are stubbed. The REAL gmail-focus
   and gmail-signals libs run (classification, scoring, ceilings, the per-user
   cache) so the route's wiring is exercised for real.

   Two behaviors carry the most weight here:
   - A VALID ranking, even one where nothing clears the bar, is HONORED. The
     deterministic-only path runs on real failures (timeout / exception /
     unparseable output), never to override a genuine verdict.
   - A ranking failure is REPORTED (`degraded: true`). The route promised this
     flag in its contract comment but never set it, so a total AI outage
     rendered as working AI ranking — which is why the bug survived to a
     production screenshot.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    threads: [] as unknown[],
    gemini: null as null | { text: string; model: string } | (() => never),
    claude: null as null | string | (() => never),
    claudeConfigured: false,
    auditRows: [] as Record<string, unknown>[],
    prefs: { vips: [] as { value: string; category: 'business' | 'personal' }[], goals: '' },
  },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/google-session', () => ({
  resolveGoogleAuth: vi.fn(async () => ({ ok: true, accessToken: 'tok' })),
  googleApiErrorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 502 }),
}))
vi.mock('@/lib/google', () => ({ listRecentGmailThreads: vi.fn(async () => state.threads) }))
vi.mock('@/lib/ai-audit', () => ({
  recordAiAction: vi.fn(async (row: Record<string, unknown>) => { state.auditRows.push(row) }),
}))
vi.mock('@/lib/gemini', () => ({
  geminiGenerateText: vi.fn(async () => {
    if (typeof state.gemini === 'function') return state.gemini()
    return state.gemini
  }),
}))
vi.mock('@/lib/claude', () => ({
  isClaudeConfigured: vi.fn(() => state.claudeConfigured),
  claudeChat: vi.fn(async () => {
    if (typeof state.claude === 'function') return state.claude()
    return state.claude
  }),
}))
// The pure helpers (focusPreferencesSignature) run real; only the DB read is stubbed.
vi.mock('@/lib/focus-preferences-db', () => ({
  getFocusPreferences: vi.fn(async () => state.prefs),
}))

import { GET } from '@/app/api/google/gmail/focus/route'
import { __resetFocusCacheForTest } from '@/lib/gmail-focus'

const req = () => new NextRequest('http://localhost/api/google/gmail/focus')

/** Base thread shape with the triage fields parseGmailThreadMeta now supplies. */
const baseThread = {
  date: new Date().toUTCString(),
  isUnread: true,
  messageCount: 1,
  labelIds: ['INBOX', 'UNREAD'],
  threadLabelIds: ['INBOX', 'UNREAD'],
  receivedAt: Date.now() - 1800_000,
  headers: {} as Record<string, string>,
  addressedDirectly: true,
  inTo: true,
  ccOnly: false,
  recipientCount: 1,
  undisclosedRecipients: false,
  userReplied: false,
  hasDraft: false,
}

/** A thread the user is genuinely in — clears the bar deterministically. */
const hotThread = {
  ...baseThread,
  id: 'hot',
  subject: 'Contract ready for signature',
  from: 'Sarah Allen <sarah@example.com>',
  snippet: 'Please review and sign',
  messageCount: 3,
  threadLabelIds: ['INBOX', 'UNREAD', 'SENT'],
  userReplied: true,
}

/** The mass mail from the reported screenshot. */
const newsletter = {
  ...baseThread,
  id: 'brew',
  subject: 'The Fed blinks',
  from: 'Morning Brew <crew@morningbrew.com>',
  snippet: 'Good morning. Markets opened…',
  labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'],
  headers: { 'list-unsubscribe': '<https://morningbrew.com/unsub>' },
}

const ranking = (rows: Record<string, unknown>[]) => JSON.stringify(rows)

beforeEach(() => {
  __resetFocusCacheForTest()
  state.session = { user: { email: 'danny@rxfitatx.com' } }
  state.threads = [hotThread]
  state.gemini = null
  state.claude = null
  state.claudeConfigured = false
  state.auditRows = []
  state.prefs = { vips: [], goals: '' }
})
afterEach(() => vi.clearAllMocks())

describe('GET /api/google/gmail/focus', () => {
  it('honors a verdict in which nothing clears the bar', async () => {
    state.gemini = {
      text: ranking([{ id: 'hot', evidence: 'Contract ready', evidence_type: 'none', level: 'none', action: 'archive' }]),
      model: 'gemini-3.5-flash',
    }

    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = await res.json()

    expect(json.items).toEqual([])
    expect(json.degraded).toBe(false)
    const row = state.auditRows[0]
    expect(row.status).toBe('success')
    expect((row.target as Record<string, unknown>).model).toBe('gemini-3.5-flash')
    expect(row.error).toBeUndefined()
  })

  it('returns the model ranking when the AI produces valid items', async () => {
    state.gemini = {
      text: ranking([{ id: 'hot', evidence: 'Contract ready for signature', evidence_type: 'deadline', level: 'urgent', action: 'reply' }]),
      model: 'gemini-3.5-flash',
    }
    const json = await (await GET(req())).json()
    expect(json.items.map((i: { id: string }) => i.id)).toEqual(['hot'])
    expect(json.degraded).toBe(false)
    expect(json.model).toBe('gemini-3.5-flash')
    expect(state.auditRows[0].status).toBe('success')
  })

  it('builds the reason from the verified quote, not from model prose', async () => {
    state.gemini = {
      text: ranking([{ id: 'hot', evidence: 'Please review and sign', evidence_type: 'direct_question', level: 'urgent', action: 'reply' }]),
      model: 'gemini-3.5-flash',
    }
    const json = await (await GET(req())).json()
    expect(json.items[0].reason).toBe('Asks you: "Please review and sign"')
  })

  it('keeps bulk mail out of the strip even when the model calls it urgent', async () => {
    state.threads = [newsletter]
    state.gemini = {
      text: ranking([{ id: 'brew', evidence: 'The Fed blinks', evidence_type: 'deadline', level: 'urgent', action: 'reply' }]),
      model: 'gemini-3.5-flash',
    }
    const json = await (await GET(req())).json()
    expect(json.items).toEqual([])
  })

  it('reproduces the reported screenshot: only the real correspondent survives', async () => {
    state.threads = [newsletter, hotThread, {
      ...baseThread,
      id: 'yelp',
      subject: 'Danny, 3 people viewed your page',
      from: 'Yelp for Business <yelp-business@yelp.com>',
      snippet: 'Get a $300 credit',
      labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'],
      headers: { 'list-unsubscribe': '<https://yelp.com/unsub>' },
    }]
    state.gemini = () => { throw new Error('model down') }

    const json = await (await GET(req())).json()
    expect(json.items.map((i: { id: string }) => i.id)).toEqual(['hot'])
    // And nothing claims a human wrote the mail it didn't.
    for (const item of json.items) expect(item.reason).not.toMatch(/real person|individual/i)
  })

  it('enriches items with sender/subject from LIVE thread data (fresh AND cached responses)', async () => {
    state.gemini = {
      text: ranking([{ id: 'hot', evidence: 'Contract ready for signature', evidence_type: 'deadline', level: 'urgent', action: 'reply' }]),
      model: 'gemini-3.5-flash',
    }
    const fresh = await (await GET(req())).json()
    expect(fresh.cached).toBe(false)
    expect(fresh.items[0].from).toBe(hotThread.from)
    expect(fresh.items[0].subject).toBe(hotThread.subject)

    const second = await (await GET(req())).json()
    expect(second.cached).toBe(true)
    expect(second.items[0].from).toBe(hotThread.from)
    expect(second.items[0].subject).toBe(hotThread.subject)
    // A cache hit reports the same health information as a fresh miss.
    expect(second.degraded).toBe(false)
    expect(second.model).toBe('gemini-3.5-flash')
  })

  it('falls back to Claude when the Gemini chain is unavailable', async () => {
    state.gemini = () => { throw new Error('All Gemini models failed or cooling down') }
    state.claudeConfigured = true
    state.claude = ranking([
      { id: 'hot', evidence: 'Contract ready for signature', evidence_type: 'deadline', level: 'urgent', action: 'reply' },
    ])

    const json = await (await GET(req())).json()
    expect(json.items.map((i: { id: string }) => i.id)).toEqual(['hot'])
    expect(json.degraded).toBe(false)
    expect(json.model).toBe('claude-fallback')
    expect(state.auditRows[0].status).toBe('success')
  })

  it('reports the outage when both providers fail, and still renders from inbox signals', async () => {
    state.gemini = () => { throw new Error('gemini exploded') }
    state.claudeConfigured = false

    const json = await (await GET(req())).json()
    expect(json.items.map((i: { id: string }) => i.id)).toEqual(['hot'])
    expect(json.degraded).toBe(true)
    expect(json.model).toBe('deterministic')
    expect(json.aiFailure).toContain('gemini exploded')
    const row = state.auditRows[0]
    expect(row.status).toBe('failed')
    expect(row.error).toContain('gemini exploded')
  })

  it('treats unparseable model output as a failure, not a verdict', async () => {
    state.gemini = { text: 'I could not produce JSON, sorry.', model: 'gemini-3.5-flash' }

    const json = await (await GET(req())).json()
    expect(json.degraded).toBe(true)
    expect(json.items.map((i: { id: string }) => i.id)).toEqual(['hot'])
    const row = state.auditRows[0]
    expect(row.status).toBe('failed')
    expect(row.error).toBe('unparseable model output')
  })

  it('flows VIP preferences through to the deterministic path', async () => {
    state.prefs = { vips: [{ value: 'sarah@example.com', category: 'business' }], goals: '' }
    state.gemini = () => { throw new Error('down') }

    const json = await (await GET(req())).json()
    expect(json.items.map((i: { id: string }) => i.id)).toEqual(['hot'])
    expect(json.items[0].reason).toMatch(/VIP/)
    expect(json.items[0].action).toBe('reply')
  })

  it('returns an empty strip (no audit) for a truly empty inbox', async () => {
    state.threads = []
    const json = await (await GET(req())).json()
    expect(json.items).toEqual([])
    expect(state.auditRows).toHaveLength(0) // no model call, no audit
  })
})
