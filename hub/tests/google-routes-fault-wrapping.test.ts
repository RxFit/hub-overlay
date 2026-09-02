import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   The Google route family under withFault (ERROR_REPORTING_2026-08-24.md §3
   Layer 3).

   tests/route-fault-coverage.test.ts already proves every handler here carries
   the FAULT_WRAPPED brand. That is a structural check — it says the wrapper is
   ATTACHED, not that attaching it did the right thing. This file covers the two
   behaviors the sweep could plausibly have got wrong, on real routes:

     1. a throw with no local try/catch now becomes a well-formed 500
        problem+json instead of Next's opaque crash page, and
     2. the wrapper did NOT capture responses that were already correct — the
        deliberate 200-with-MISSING_SCOPE degrade and the googleApiErrorResponse
        status mapping both pass through byte-compatible.

   (2) is the one that would bite silently: withFault's 2xx contract check
   returns a 500 outside production when a 2xx body carries error/reason/
   ok:false, so a degrade path that had been written with `error:` in the body
   would have flipped to a dev-500 the moment the wrapper went on.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: { session: null as unknown, token: null as unknown },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => state.token) }))

// Only the People lookup is stubbed; the route and the wrapper run real.
const { chatSelf } = vi.hoisted(() => ({ chatSelf: vi.fn() }))
vi.mock('@/lib/google', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google')>()),
  getChatSelfUserName: chatSelf,
}))

import { GET as chatMe } from '@/app/api/google/chat/me/route'
import { GET as readState } from '@/app/api/google/chat/readstate/route'
import { GET as members } from '@/app/api/google/chat/members/route'
import { _resetFaultReportStateForTests, getFaultReportCounters } from '@/lib/fault-report'

const FAULT_ID = /^HUB-[A-Z2-7]{8}$/
const realFetch = global.fetch

function get(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { method: 'GET', headers })
}

beforeEach(() => {
  state.session = { user: { email: 'danny@rxfitatx.com' } }
  state.token = { accessToken: 'tok' }
  chatSelf.mockReset()
  _resetFaultReportStateForTests()
})

afterEach(() => {
  global.fetch = realFetch
  vi.clearAllMocks()
})

describe('google routes — withFault turns an unguarded throw into a fault response', () => {
  it('/api/google/chat/me answers 500 problem+json with a fault id (the handler has no try/catch)', async () => {
    chatSelf.mockRejectedValueOnce(new Error('people.googleapis.com exploded'))

    const res = await chatMe(get('http://localhost/api/google/chat/me'))

    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    expect(res.headers.get('x-hub-fault-id')).toMatch(FAULT_ID)
    const body = await res.json()
    expect(body.code).toBe('internal')
    expect(body.instance).toMatch(FAULT_ID)
    // The user-facing text is the fixed per-code message; the upstream string
    // only ever appears in the non-production `details` field.
    expect(body.error).not.toContain('people.googleapis.com')
    // …and the fault reached the reporter, which is the whole point of wrapping.
    expect(getFaultReportCounters().reported).toBe(1)
  })

  it('mints a request id and echoes it on the response, honoring a valid inbound UUID', async () => {
    chatSelf.mockResolvedValue('users/12345')

    const minted = await chatMe(get('http://localhost/api/google/chat/me'))
    expect(minted.headers.get('x-hub-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )

    const supplied = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
    const echoed = await chatMe(
      get('http://localhost/api/google/chat/me', { 'x-hub-request-id': supplied }),
    )
    expect(echoed.headers.get('x-hub-request-id')).toBe(supplied)

    // A non-UUID is never trusted (correlation poisoning) — a fresh id is minted.
    const spoofed = await chatMe(
      get('http://localhost/api/google/chat/me', { 'x-hub-request-id': 'not-a-uuid' }),
    )
    expect(spoofed.headers.get('x-hub-request-id')).not.toBe('not-a-uuid')
  })
})

describe('google routes — the wrapper leaves already-correct responses alone', () => {
  it('the readstate 200 MISSING_SCOPE degrade survives the 2xx contract check', async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED' } }), {
          status: 403,
        }),
    ) as typeof fetch

    const res = await readState(
      get('http://localhost/api/google/chat/readstate?spaceId=spaces/AAA'),
    )

    // Still 200: the client read hook must not see an error for a scope the
    // user simply has not re-consented to yet.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.code).toBe('MISSING_SCOPE')
    expect(body.lastReadTime).toBeNull()
    // The degrade body deliberately carries no `error`/`reason`/`ok:false` key,
    // so detectErrorIn2xx finds nothing and reports nothing.
    expect(getFaultReportCounters().reported).toBe(0)
  })

  it('googleApiErrorResponse keeps its own status mapping (a 401 reauth stays a 401)', async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }), {
          status: 401,
        }),
    ) as typeof fetch

    const res = await members(
      get('http://localhost/api/google/chat/members?spaceId=spaces/AAA'),
    )

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.reauth).toBe(true)
    // Not re-reported by withFault: the helper already reported it once, and
    // the handler returned rather than threw.
    expect(getFaultReportCounters().reported).toBe(1)
  })
})
