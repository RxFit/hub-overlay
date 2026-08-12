import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/google/chat/spaces GET  — annotated space list + visibility preferences
   /api/google/chat/spaces/preferences GET/PUT — per-user visibility overrides

   Mocking boundary mirrors the sibling Google route tests: next-auth's
   session/JWT readers, the DB preference layer, and the global fetch aimed at
   Google are stubbed; the routes' own classification/validation logic runs REAL.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    token: null as unknown,
    prefs: { shown: [] as string[], hidden: [] as string[] },
    upsertThrows: false,
    upsertCalls: [] as unknown[],
  },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => state.token) }))
vi.mock('@/lib/chat-space-preferences-db', () => ({
  getChatSpacePreferences: vi.fn(async () => state.prefs),
  upsertChatSpacePreferences: vi.fn(async (email: string, prefs: unknown) => {
    state.upsertCalls.push({ email, prefs })
    if (state.upsertThrows) throw new Error('db down')
    return prefs
  }),
}))

import { GET } from '@/app/api/google/chat/spaces/route'
import { GET as PREFS_GET, PUT as PREFS_PUT } from '@/app/api/google/chat/spaces/preferences/route'

const realFetch = global.fetch

/** A representative Chat `spaces.list` payload: one real space, plus clutter. */
const GOOGLE_SPACES = {
  spaces: [
    { name: 'spaces/OPS', displayName: 'RxFit Ops', spaceType: 'SPACE', type: 'ROOM' },
    { name: 'spaces/MEET', displayName: '', spaceType: 'GROUP_CHAT', type: 'GROUP_CHAT' },
    { name: 'spaces/DM1', displayName: '', spaceType: 'DIRECT_MESSAGE', type: 'DM' },
    // App DM: like every DM it has NO displayName of its own — the route must
    // hydrate one from the BOT membership below.
    { name: 'spaces/BOT', displayName: '', spaceType: 'DIRECT_MESSAGE', type: 'DM', singleUserBotDm: true },
  ],
}

/** The BOT membership of spaces/BOT — the only place the app's name exists. */
const BOT_MEMBERSHIP = {
  memberships: [
    {
      name: 'spaces/BOT/members/app',
      member: { name: 'users/app', displayName: 'Hermes', type: 'BOT' },
      role: 'ROLE_MEMBER',
      state: 'MEMBER_JOINED',
    },
  ],
}

function stubGoogle(handler: (url: string) => Response) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch
}

/** Default stub: spaces.list plus the members call the bot-DM naming makes. */
function stubGoogleSpacesAndMembers() {
  stubGoogle(url => {
    if (url.includes('/members')) return new Response(JSON.stringify(BOT_MEMBERSHIP), { status: 200 })
    return new Response(JSON.stringify(GOOGLE_SPACES), { status: 200 })
  })
}

function req(url = 'http://localhost/api/google/chat/spaces') {
  return new NextRequest(url)
}

function putReq(body: unknown) {
  return new NextRequest('http://localhost/api/google/chat/spaces/preferences', {
    method: 'PUT',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  state.session = { user: { email: 'danny@rxfitatx.com' } }
  state.token = { accessToken: 'tok' }
  state.prefs = { shown: [], hidden: [] }
  state.upsertThrows = false
  state.upsertCalls = []
  stubGoogleSpacesAndMembers()
})

afterEach(() => {
  global.fetch = realFetch
  vi.clearAllMocks()
})

describe('GET /api/google/chat/spaces', () => {
  it('annotates every space with its kind and default visibility', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()

    const byName = Object.fromEntries(body.spaces.map((s: any) => [s.name, s]))
    expect(byName['spaces/OPS']).toMatchObject({ kind: 'named', defaultVisible: true })
    expect(byName['spaces/MEET']).toMatchObject({ kind: 'group', defaultVisible: false })
    expect(byName['spaces/DM1']).toMatchObject({ kind: 'dm', defaultVisible: false })
    expect(byName['spaces/BOT']).toMatchObject({ kind: 'bot', defaultVisible: false })
  })

  it('returns every listed space — INCLUDING app DMs — so Settings can offer the hidden ones', async () => {
    // Filtering is the client's job — the panel shows the visible subset, but
    // Settings must be able to list what is being hidden. Bot DMs used to be
    // dropped inside lib/google.ts, which made conversations with Chat apps
    // (the Hermes agent) impossible to surface at all; they now flow through
    // and are simply hidden by default like other non-named conversations.
    const body = await (await GET(req())).json()
    expect(body.spaces.map((s: any) => s.name)).toEqual(['spaces/OPS', 'spaces/MEET', 'spaces/DM1', 'spaces/BOT'])
  })

  it('names an app DM after its bot member (DM spaces carry no displayName)', async () => {
    const body = await (await GET(req())).json()
    const bot = body.spaces.find((s: any) => s.name === 'spaces/BOT')
    expect(bot.displayName).toBe('Hermes')
    // Membership lookups are scoped to BOT members of bot DMs only — exactly
    // one extra call for this fixture, none for the human DM.
    const memberCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map(c => String(c[0]))
      .filter(u => u.includes('/members'))
    expect(memberCalls).toHaveLength(1)
    expect(memberCalls[0]).toContain('spaces/BOT/members')
    // URLSearchParams form-encodes spaces as '+'
    expect(decodeURIComponent(memberCalls[0].replace(/\+/g, ' '))).toContain('member.type = "BOT"')
  })

  it('keeps the space list usable when the naming lookup fails (fail-soft)', async () => {
    stubGoogle(url => {
      if (url.includes('/members')) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify(GOOGLE_SPACES), { status: 200 })
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    const bot = body.spaces.find((s: any) => s.name === 'spaces/BOT')
    expect(bot).toBeDefined()
    expect(bot.displayName).toBe('') // unnamed, but present and openable
  })

  it('ships the user preferences alongside, so the panel never flashes all spaces', async () => {
    state.prefs = { shown: ['spaces/DM1'], hidden: [] }
    const body = await (await GET(req())).json()
    expect(body.preferences).toEqual({ shown: ['spaces/DM1'], hidden: [] })
  })

  it('keeps the dedicated MISSING_SCOPE 403 for an un-granted Chat scope', async () => {
    stubGoogle(() => new Response(JSON.stringify({ error: { message: 'insufficientPermissions' } }), { status: 403 }))
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('MISSING_SCOPE')
  })

  it('401s with reauth when there is no Google token', async () => {
    state.token = null
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect((await res.json()).reauth).toBe(true)
  })

  it('503s WITHOUT reauth when the token refresh failed transiently', async () => {
    // The whole point of the transient/fatal split: a Google blip must not log
    // the user out.
    state.token = { accessToken: 'tok', error: 'RefreshTransientError' }
    const res = await GET(req())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.reauth).toBe(false)
    expect(body.retryable).toBe(true)
  })
})

describe('GET /api/google/chat/spaces/preferences', () => {
  it('returns the stored preferences', async () => {
    state.prefs = { shown: ['spaces/DM1'], hidden: ['spaces/OPS'] }
    const res = await PREFS_GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ shown: ['spaces/DM1'], hidden: ['spaces/OPS'] })
  })

  it('401s without a session', async () => {
    state.session = null
    expect((await PREFS_GET(req())).status).toBe(401)
  })
})

describe('PUT /api/google/chat/spaces/preferences', () => {
  it('persists normalized preferences and echoes what was stored', async () => {
    const res = await PREFS_PUT(putReq({ shown: ['spaces/B', 'spaces/A', 'spaces/A'], hidden: [] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ shown: ['spaces/A', 'spaces/B'], hidden: [] })
  })

  it('strips malformed space names before they reach the DB', async () => {
    await PREFS_PUT(putReq({ shown: ['spaces/OK', 'javascript:alert(1)', ''], hidden: ['../etc'] }))
    expect(state.upsertCalls[0]).toMatchObject({
      prefs: { shown: ['spaces/OK'], hidden: [] },
    })
  })

  it('401s without a session', async () => {
    state.session = null
    expect((await PREFS_PUT(putReq({ shown: [], hidden: [] }))).status).toBe(401)
  })

  it('400s on malformed JSON', async () => {
    expect((await PREFS_PUT(putReq('{not json'))).status).toBe(400)
  })

  it('502s on a write failure instead of reporting a false success', async () => {
    // A silent "saved" that did not persist is the exact bug this feature fixes.
    state.upsertThrows = true
    const res = await PREFS_PUT(putReq({ shown: ['spaces/A'], hidden: [] }))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/could not save/i)
  })
})
