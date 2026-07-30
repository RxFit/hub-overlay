import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/google/gmail — drafts-first send (§6.1).

   A send is two calls: `mode: 'draft'` creates the message in Gmail, and a
   follow-up `{ draftId }` delivers it. The split exists so a delivery failure
   leaves the composed email recoverable rather than losing it.

   Mocking boundary matches the sibling Google route tests: next-auth's
   session/JWT readers, the gate and the audit sink are stubbed; the route's own
   validation, MIME building and branching run REAL.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    token: null as unknown,
    gateOk: true,
    audits: [] as { status: string; error?: string; target?: unknown }[],
    limitAllowed: true,
  },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => state.token) }))
vi.mock('@/lib/requireGate', () => ({
  requireAiGate: vi.fn(() => (state.gateOk ? { ok: true } : { ok: false, error: 'bad gate', status: 403 })),
  AI_INTENT_HEADER: 'x-ai-intent',
  GATE_TOKEN_HEADER: 'x-gate-token',
}))
vi.mock('@/lib/ai-audit', () => ({
  recordAiAction: vi.fn(async (row: { status: string }) => { state.audits.push(row) }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkActionLimit: vi.fn(() => ({ allowed: state.limitAllowed, retryAfterSec: 60 })),
}))

import { POST } from '@/app/api/google/gmail/route'

const realFetch = global.fetch
let calls: { url: string; body: unknown }[] = []

function stubGmail(handler: (url: string) => Response) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return handler(url)
  }) as typeof fetch
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/google/gmail', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

const AI_HEADERS = { 'x-ai-intent': 'send_gmail', 'x-gate-token': 'tok' }

beforeEach(() => {
  calls = []
  state.session = { user: { email: 'danny@rxfitatx.com' } }
  state.token = { accessToken: 'ya29.tok' }
  state.gateOk = true
  state.audits = []
  state.limitAllowed = true
})

afterEach(() => {
  global.fetch = realFetch
  vi.clearAllMocks()
})

describe('mode: draft — create without sending', () => {
  it('POSTs to /drafts and returns the draft id WITHOUT sending', async () => {
    stubGmail(() => new Response(JSON.stringify({ id: 'draft-1', message: { id: 'm1', threadId: 't1' } }), { status: 200 }))

    const res = await POST(post({ to: 'maria@x.com', subject: 'Hi', message: 'Body', mode: 'draft' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ sent: false, draftId: 'draft-1' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/drafts')
    expect(calls[0].url).not.toContain('/messages/send')
  })

  it('wraps the encoded message under `message`, as the drafts API requires', async () => {
    stubGmail(() => new Response(JSON.stringify({ id: 'draft-1' }), { status: 200 }))
    await POST(post({ to: 'maria@x.com', subject: 'Hi', message: 'Body', mode: 'draft' }))

    const sent = calls[0].body as { message?: { raw?: string } }
    expect(sent.message?.raw).toBeTruthy()
    const decoded = Buffer.from(String(sent.message!.raw).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    expect(decoded).toContain('To: maria@x.com')
    expect(decoded).toContain('Subject: Hi')
    expect(decoded).toContain('Body')
  })

  it('does NOT write a send audit row — a draft delivers nothing', async () => {
    stubGmail(() => new Response(JSON.stringify({ id: 'draft-1' }), { status: 200 }))
    await POST(post({ to: 'maria@x.com', subject: 'Hi', message: 'Body', mode: 'draft' }, AI_HEADERS))
    expect(state.audits).toHaveLength(0)
  })

  it('still rejects a malformed recipient before reaching Gmail', async () => {
    stubGmail(() => new Response('{}', { status: 200 }))
    const res = await POST(post({ to: 'not-an-email', message: 'Body', mode: 'draft' }))

    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('still enforces the AI gate', async () => {
    state.gateOk = false
    const res = await POST(post({ to: 'maria@x.com', message: 'Body', mode: 'draft' }, AI_HEADERS))
    expect(res.status).toBe(403)
  })
})

describe('default mode — unchanged send path', () => {
  it('sends directly when no mode is given, preserving the existing contract', async () => {
    stubGmail(() => new Response(JSON.stringify({ id: 'm1', threadId: 't1' }), { status: 200 }))

    const res = await POST(post({ to: 'maria@x.com', subject: 'Hi', message: 'Body' }))
    const body = await res.json()

    expect(body).toMatchObject({ sent: true, messageId: 'm1' })
    expect(calls[0].url).toContain('/messages/send')
  })
})

describe('draftId — deliver an existing draft', () => {
  it('POSTs the draft id to /drafts/send and reports the sent message', async () => {
    stubGmail(() => new Response(JSON.stringify({ id: 'm9', threadId: 't9' }), { status: 200 }))

    const res = await POST(post({ draftId: 'draft-1' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ sent: true, messageId: 'm9', threadId: 't9' })
    expect(calls[0].url).toContain('/drafts/send')
    expect(calls[0].body).toEqual({ id: 'draft-1' })
  })

  it('writes exactly one success audit row for an AI-originated send', async () => {
    stubGmail(() => new Response(JSON.stringify({ id: 'm9', threadId: 't9' }), { status: 200 }))
    await POST(post({ draftId: 'draft-1' }, AI_HEADERS))

    expect(state.audits).toHaveLength(1)
    expect(state.audits[0]).toMatchObject({ status: 'success', target: { draftId: 'draft-1' } })
  })

  it('enforces the rate limit on the DELIVERING call', async () => {
    state.limitAllowed = false
    const res = await POST(post({ draftId: 'draft-1' }, AI_HEADERS))

    expect(res.status).toBe(429)
    expect(calls).toHaveLength(0)
    expect(state.audits[0]).toMatchObject({ status: 'failed', error: 'rate_limited' })
  })

  it('tells the user the draft SURVIVED when delivery fails', async () => {
    // The entire point of drafts-first: the composed email is not lost.
    stubGmail(() => new Response('upstream exploded', { status: 503 }))

    const res = await POST(post({ draftId: 'draft-1' }, AI_HEADERS))
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body.error).toMatch(/saved in your Gmail drafts/i)
    expect(body.draftId).toBe('draft-1')
    expect(state.audits[0]).toMatchObject({ status: 'failed' })
  })

  it('maps an auth failure to the shared reauth response rather than a draft note', async () => {
    stubGmail(() => new Response('bad creds', { status: 401 }))
    const res = await POST(post({ draftId: 'draft-1' }, AI_HEADERS))
    expect(res.status).toBe(401)
  })

  it('rejects an empty draft id', async () => {
    stubGmail(() => new Response('{}', { status: 200 }))
    // Falls through to the compose schema, which requires `to` and `message`.
    const res = await POST(post({ draftId: '' }))
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})
