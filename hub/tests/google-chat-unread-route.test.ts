import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/google/chat/unread — the badge poll must stay CHEAP.

   The route used to pull the latest 50 FULL messages per space per poll and
   compare timestamps in JS. It now asks Google to do both halves: a
   `createTime > lastReadTime` filter (server-side) plus a `fields` mask that
   strips the response to message names. These tests pin that wire contract —
   a regression back to full-body pulls would pass a pure count assertion, so
   the URL shape itself is asserted.

   Mocking boundary mirrors the sibling chat route tests: next-auth readers
   mocked, global fetch stubbed, the route's own logic REAL.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    token: null as unknown,
  },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => null) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => state.token) }))

import { GET } from '@/app/api/google/chat/unread/route'

const realFetch = global.fetch

/** lastReadTime per space; spaces absent here have NO readstate (never opened). */
const READ_TIMES: Record<string, string> = {
  'spaces/A': '2026-08-20T10:00:00Z',
  'spaces/B': '2026-08-20T11:00:00Z',
}

/** Unread message stubs (names only — what the field mask leaves) per space. */
const UNREAD_STUBS: Record<string, { name: string; createTime: string }[]> = {
  'spaces/A': [
    { name: 'spaces/A/messages/m1', createTime: '2026-08-20T10:05:00Z' },
    { name: 'spaces/A/messages/m2', createTime: '2026-08-20T10:06:00Z' },
  ],
  'spaces/B': [],
}

function stubGoogle() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const spaceId = url.match(/spaces\/[A-Z]+/)?.[0] ?? ''
    if (url.includes('spaceReadState')) {
      const lastReadTime = READ_TIMES[spaceId]
      if (!lastReadTime) return new Response(JSON.stringify({ name: 'x' }), { status: 200 })
      return new Response(JSON.stringify({ name: 'x', lastReadTime }), { status: 200 })
    }
    if (url.includes('/messages')) {
      return new Response(JSON.stringify({ messages: UNREAD_STUBS[spaceId] ?? [] }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
}

function req(spaceIds: string) {
  return new NextRequest(`http://localhost/api/google/chat/unread?spaceIds=${encodeURIComponent(spaceIds)}`)
}

function messageUrls(): string[] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    .map(c => String(c[0]))
    .filter(u => u.includes('/messages'))
}

beforeEach(() => {
  state.token = { accessToken: 'tok' }
  stubGoogle()
})

afterEach(() => {
  global.fetch = realFetch
  vi.clearAllMocks()
})

describe('GET /api/google/chat/unread', () => {
  it('counts unread from the server-filtered listing and totals across spaces', async () => {
    const res = await GET(req('spaces/A,spaces/B'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ unread: { 'spaces/A': 2, 'spaces/B': 0 }, total: 2 })
  })

  it('asks Google to filter and mask — never pulls full message bodies', async () => {
    await GET(req('spaces/A'))
    const urls = messageUrls()
    expect(urls).toHaveLength(1)
    const decoded = decodeURIComponent(urls[0].replace(/\+/g, ' '))
    expect(decoded).toContain('filter=createTime > "2026-08-20T10:00:00Z"')
    expect(decoded).toContain('fields=messages(name,createTime)')
  })

  it('skips the messages call entirely for a space with no readstate', async () => {
    const res = await GET(req('spaces/NEVEROPENED'))
    expect(await res.json()).toEqual({ unread: {}, total: 0 })
    expect(messageUrls()).toHaveLength(0)
  })

  it('degrades a single failing space to absent without blanking the others', async () => {
    const okFetch = global.fetch as ReturnType<typeof vi.fn>
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('spaces/BAD')) return new Response('boom', { status: 500 })
      return okFetch(input as RequestInfo)
    }) as typeof fetch

    const res = await GET(req('spaces/A,spaces/BAD'))
    expect(await res.json()).toEqual({ unread: { 'spaces/A': 2 }, total: 2 })
  })

  it('401s with reauth when there is no Google token', async () => {
    state.token = null
    const res = await GET(req('spaces/A'))
    expect(res.status).toBe(401)
    expect((await res.json()).reauth).toBe(true)
  })
})
