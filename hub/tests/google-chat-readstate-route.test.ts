import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/google/chat/readstate POST — mark-a-space-read (unread badge clearing).

   Mocking boundary mirrors the sibling Google route tests: only next-auth's
   session/JWT readers and the global fetch aimed at Google are stubbed; the
   route's own validation and scope-degrade logic run REAL.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    token: null as unknown,
  },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => state.token) }))

import { POST } from '@/app/api/google/chat/readstate/route'

const realFetch = global.fetch
let fetchCalls: { url: string; init?: RequestInit }[] = []

function postReq(body: unknown) {
  return new NextRequest('http://localhost/api/google/chat/readstate', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubGoogle(handler: (url: string) => Response) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    fetchCalls.push({ url, init })
    return handler(url)
  }) as typeof fetch
}

beforeEach(() => {
  fetchCalls = []
  state.session = { user: { email: 'danny@rxfitatx.com' } }
  state.token = { accessToken: 'tok' }
})

afterEach(() => {
  global.fetch = realFetch
  vi.clearAllMocks()
})

describe('POST /api/google/chat/readstate', () => {
  it('PATCHes the Chat readstate API with a lastReadTime and updateMask', async () => {
    stubGoogle(() =>
      new Response(JSON.stringify({ name: 'users/me/spaces/AAA/spaceReadState', lastReadTime: '2026-07-19T00:00:00Z' }), { status: 200 })
    )
    const res = await POST(postReq({ spaceId: 'spaces/AAA' }))
    if (res.status !== 200) console.log('FAIL BODY:', await res.json())
    expect(res.status).toBe(200)
    expect((await res.json()).lastReadTime).toBe('2026-07-19T00:00:00Z')

    const call = fetchCalls[0]
    expect(call.url).toContain('/users/me/spaces/AAA/spaceReadState')
    expect(call.url).toContain('updateMask=lastReadTime')
    expect(call.init?.method).toBe('PATCH')
    const body = JSON.parse(String(call.init?.body))
    // A real ISO timestamp, not a placeholder.
    expect(Number.isNaN(new Date(body.lastReadTime).getTime())).toBe(false)
  })

  it('rejects a missing or malformed spaceId without calling Google', async () => {
    stubGoogle(() => new Response('{}', { status: 200 }))
    expect((await POST(postReq({}))).status).toBe(400)
    expect((await POST(postReq({ spaceId: 'not-a-space' }))).status).toBe(400)
    expect((await POST(postReq({ spaceId: 'spaces/../evil' }))).status).toBe(400)
    expect(fetchCalls).toHaveLength(0)
  })

  it('degrades a 403 (pre-upgrade readonly token) to MISSING_SCOPE, not an error', async () => {
    stubGoogle(() => new Response('PERMISSION_DENIED', { status: 403 }))
    const res = await POST(postReq({ spaceId: 'spaces/AAA' }))
    expect(res.status).toBe(200)
    expect((await res.json()).code).toBe('MISSING_SCOPE')
  })
})
