import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/google/gmail/focus/preferences — per-user VIP list + goals.

   Auth-only (personal-productivity config). The pure normalizeFocusPreferences
   runs REAL; only the DB read/write helpers are stubbed, so the route's
   normalize-before-save contract and auth gating are exercised for real.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    stored: null as unknown,
    upsertArg: null as unknown,
    upsertThrows: false,
  },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
// normalizeFocusPreferences (pure) runs real from '@/lib/focus-preferences';
// only the DB helpers in '-db' are stubbed.
vi.mock('@/lib/focus-preferences-db', () => ({
  getFocusPreferences: vi.fn(async () => state.stored ?? { vips: [], goals: '' }),
  upsertFocusPreferences: vi.fn(async (_email: string, prefs: unknown) => {
    if (state.upsertThrows) throw new Error('db down')
    state.upsertArg = prefs
    return prefs // route already normalized before calling
  }),
}))

import { GET, PUT } from '@/app/api/google/gmail/focus/preferences/route'

const putReq = (body: unknown) =>
  new NextRequest('http://localhost/api/google/gmail/focus/preferences', {
    method: 'PUT',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
const getReq = () => new NextRequest('http://localhost/api/google/gmail/focus/preferences')

beforeEach(() => {
  state.session = { user: { email: 'danny@rxfitatx.com' } }
  state.stored = null
  state.upsertArg = null
  state.upsertThrows = false
})
afterEach(() => vi.clearAllMocks())

describe('GET /api/google/gmail/focus/preferences', () => {
  it('401 without a session', async () => {
    state.session = null
    expect((await GET(getReq())).status).toBe(401)
  })

  it('returns the stored preferences', async () => {
    state.stored = { vips: [{ value: 'a@b.com', category: 'business' }], goals: 'ship it' }
    const json = await (await GET(getReq())).json()
    expect(json).toEqual(state.stored)
  })
})

describe('PUT /api/google/gmail/focus/preferences', () => {
  it('401 without a session', async () => {
    state.session = null
    expect((await PUT(putReq({ vips: [], goals: '' }))).status).toBe(401)
  })

  it('400 on invalid JSON', async () => {
    expect((await PUT(putReq('{not json'))).status).toBe(400)
  })

  it('normalizes before saving (drops blanks + dupes, coerces category) and returns the clean result', async () => {
    const res = await PUT(putReq({
      goals: 'Close Q3',
      vips: [
        { value: 'ceo@acme.com', category: 'business' },
        { value: 'CEO@acme.com', category: 'personal' }, // dup → dropped
        { value: '  ', category: 'business' },            // blank → dropped
        { value: 'mom', category: 'weird' },              // bad category → business
      ],
    }))
    expect(res.status).toBe(200)
    const json = await res.json()
    // Route persisted the normalized value (what upsert received == what it returned).
    expect(state.upsertArg).toEqual(json)
    expect(json.goals).toBe('Close Q3')
    expect(json.vips).toEqual([
      { value: 'ceo@acme.com', category: 'business' },
      { value: 'mom', category: 'business' },
    ])
  })

  it('502 when the write fails (honest error, not a silent success)', async () => {
    state.upsertThrows = true
    const res = await PUT(putReq({ vips: [], goals: 'x' }))
    expect(res.status).toBe(502)
  })
})
