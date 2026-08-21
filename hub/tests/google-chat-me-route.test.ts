import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/google/chat/me — the caller's own Chat user name, cached per email.

   The id gates the edit/delete affordances; it is immutable per account, so
   the route must NOT re-ask People on every panel mount (positive cache), and
   a People failure must degrade to { name: null } rather than an error.
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

import { GET } from '@/app/api/google/chat/me/route'

const realFetch = global.fetch

function req() {
  return new NextRequest('http://localhost/api/google/chat/me')
}

function peopleCalls(): number {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    .filter(c => String(c[0]).includes('people/me')).length
}

beforeEach(() => {
  state.token = { accessToken: 'tok' }
  global.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ resourceName: 'people/424242' }), { status: 200 }),
  ) as typeof fetch
})

afterEach(() => {
  global.fetch = realFetch
  vi.clearAllMocks()
})

describe('GET /api/google/chat/me', () => {
  it('maps people/me onto the Chat users/ namespace and CACHES per email', async () => {
    state.session = { user: { email: 'cache-hit@rxfitatx.com' } }
    expect(await (await GET(req())).json()).toEqual({ name: 'users/424242' })
    expect(await (await GET(req())).json()).toEqual({ name: 'users/424242' })
    expect(peopleCalls()).toBe(1) // second hit served from the cache
  })

  it('degrades to { name: null } when People is unavailable — no error surface', async () => {
    state.session = { user: { email: 'degrade@rxfitatx.com' } }
    global.fetch = vi.fn(async () => new Response('denied', { status: 403 })) as typeof fetch
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: null })
  })

  it('401s with reauth when there is no Google token', async () => {
    state.token = null
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect((await res.json()).reauth).toBe(true)
  })
})
