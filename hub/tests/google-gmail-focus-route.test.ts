import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/google/gmail/focus — the AI-ranked Focus queue.

   Mocking boundary: auth (session + Google token), the Gmail thread fetch, the
   Gemini call, and the audit sink are stubbed. The REAL gmail-focus lib runs
   (parseFocusResult hardening, heuristicFocusItems fallback, the per-user
   cache) so the route's fallback wiring is exercised for real.

   Headline behavior under test: a VALID but EMPTY model ranking ("inbox of
   pure noise", which the prompt explicitly permits) must be HONORED — the
   heuristic fallback runs ONLY on a real failure (timeout / exception /
   unparseable output), never to override a genuine empty verdict.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    threads: [] as unknown[],
    gemini: null as null | { text: string; model: string } | (() => never),
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
// The pure helpers (focusPreferencesSignature) run real; only the DB read is stubbed.
vi.mock('@/lib/focus-preferences-db', () => ({
  getFocusPreferences: vi.fn(async () => state.prefs),
}))

import { GET } from '@/app/api/google/gmail/focus/route'
import { __resetFocusCacheForTest } from '@/lib/gmail-focus'

const req = () => new NextRequest('http://localhost/api/google/gmail/focus')

/** An unread human multi-message recent thread — heuristicFocusItems would
 *  surface it (score 100), so if it appears we know the heuristic ran. */
const hotThread = {
  id: 'hot',
  subject: 'Contract ready for signature',
  from: 'Sarah Allen <sarah@example.com>',
  date: new Date().toUTCString(),
  snippet: 'Please review and sign',
  isUnread: true,
  messageCount: 3,
}

beforeEach(() => {
  __resetFocusCacheForTest()
  state.session = { user: { email: 'danny@rxfitatx.com' } }
  state.threads = [hotThread]
  state.gemini = null
  state.auditRows = []
  state.prefs = { vips: [], goals: '' }
})
afterEach(() => vi.clearAllMocks())

describe('GET /api/google/gmail/focus', () => {
  it('honors a VALID EMPTY ranking — does NOT override it with the heuristic', async () => {
    state.gemini = { text: '[]', model: 'gemini-3.5-flash' }

    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = await res.json()

    // The AI said "nothing matters" → empty strip, NOT the heuristic's hot item.
    expect(json.items).toEqual([])
    // Audit credits the model and logs success (not a failure/heuristic row).
    const row = state.auditRows[0]
    expect(row.status).toBe('success')
    expect((row.target as Record<string, unknown>).model).toBe('gemini-3.5-flash')
    expect((row.target as Record<string, unknown>).itemCount).toBe(0)
    expect(row.error).toBeUndefined()
  })

  it('returns the model ranking when the AI produces valid non-empty items', async () => {
    state.gemini = {
      text: JSON.stringify([{ id: 'hot', priority: 95, reason: 'Contract awaiting signature', action: 'reply' }]),
      model: 'gemini-3.5-flash',
    }
    const json = await (await GET(req())).json()
    expect(json.items.map((i: { id: string }) => i.id)).toEqual(['hot'])
    expect(state.auditRows[0].status).toBe('success')
    expect((state.auditRows[0].target as Record<string, unknown>).model).toBe('gemini-3.5-flash')
  })

  it('enriches items with sender/subject from LIVE thread data (fresh AND cached responses)', async () => {
    state.gemini = {
      text: JSON.stringify([{ id: 'hot', priority: 95, reason: 'r', action: 'reply' }]),
      model: 'gemini-3.5-flash',
    }
    // Fresh ranking: display fields come from the Gmail thread, not the model.
    const fresh = await (await GET(req())).json()
    expect(fresh.cached).toBe(false)
    expect(fresh.items[0].from).toBe(hotThread.from)
    expect(fresh.items[0].subject).toBe(hotThread.subject)

    // Second request hits the cache — enrichment must still be applied.
    const second = await (await GET(req())).json()
    expect(second.cached).toBe(true)
    expect(second.items[0].from).toBe(hotThread.from)
    expect(second.items[0].subject).toBe(hotThread.subject)
  })

  it('falls back to the heuristic on an AI exception and logs a failure', async () => {
    state.gemini = () => { throw new Error('gemini exploded') }

    const json = await (await GET(req())).json()
    // Heuristic surfaced the hot thread instead of an empty strip.
    expect(json.items.map((i: { id: string }) => i.id)).toEqual(['hot'])
    const row = state.auditRows[0]
    expect(row.status).toBe('failed')
    expect((row.target as Record<string, unknown>).model).toBe('heuristic')
    expect(row.error).toContain('gemini exploded')
  })

  it('falls back to the heuristic on unparseable model output', async () => {
    state.gemini = { text: 'I could not produce JSON, sorry.', model: 'gemini-3.5-flash' }

    const json = await (await GET(req())).json()
    expect(json.items.map((i: { id: string }) => i.id)).toEqual(['hot'])
    const row = state.auditRows[0]
    expect(row.status).toBe('failed')
    expect(row.error).toBe('unparseable model output')
    expect((row.target as Record<string, unknown>).model).toBe('heuristic')
  })

  it('flows VIP preferences through to the heuristic fallback path', async () => {
    // A VIP matching the thread + an AI failure → the heuristic honors the VIP.
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
