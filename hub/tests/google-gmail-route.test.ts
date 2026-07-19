import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/google/gmail — the highest-blast-radius Google route (NS-11).

   Mocking boundary: ONLY the outer edges are stubbed — next-auth's session/JWT
   readers and the global `fetch` the route aims at the Gmail REST API. Every
   piece of route-owned logic runs REAL: `lib/google-session` (reauth mapping),
   `lib/requireGate` + `lib/gateToken` (HMAC gate, real tokens minted with
   `issueGateToken`), `lib/rate-limit` (driven to a genuine breach), recipient
   validation (#25), header-injection stripping, and RFC-2822 assembly (asserted
   by decoding the base64url `raw` payload the route actually built).
   `recordAiAction` is captured (DB-free) to assert the NS-2 audit contract.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    token: null as unknown,
    auditRows: [] as Record<string, unknown>[],
  },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => state.token) }))
vi.mock('@/lib/ai-audit', () => ({
  recordAiAction: vi.fn(async (row: Record<string, unknown>) => {
    state.auditRows.push(row)
  }),
}))

// Real gate tokens need a signing secret before the route modules load.
process.env.NEXTAUTH_SECRET = 'test-gate-secret'

import { GET, POST } from '@/app/api/google/gmail/route'
import { issueGateToken } from '@/lib/gateToken'
import { _reset as resetRateLimit, ACTION_LIMITS } from '@/lib/rate-limit'

/* ── helpers ── */

type FetchCall = { url: string; init?: RequestInit }
let fetchCalls: FetchCall[] = []

/** Stub global fetch with a URL-substring → response-body router. */
function stubGmail(routes: Array<[string, unknown | (() => unknown)]>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    fetchCalls.push({ url: u, init })
    for (const [needle, body] of routes) {
      if (u.includes(needle)) {
        const resolved = typeof body === 'function' ? (body as () => unknown)() : body
        if (resolved instanceof Error) {
          return { ok: false, status: Number(resolved.message) || 500, text: async () => resolved.message } as unknown as Response
        }
        return { ok: true, status: 200, json: async () => resolved } as unknown as Response
      }
    }
    return { ok: false, status: 404, text: async () => 'no stub' } as unknown as Response
  }))
}

function getReq(qs = '') {
  return new NextRequest(`http://localhost/api/google/gmail${qs}`)
}
function postReq(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/google/gmail', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })
}
function decodeRaw(raw: string): string {
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
}
const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64')

beforeEach(() => {
  state.session = { user: { email: 'danny@rxfitatx.com' } }
  state.token = { accessToken: 'goog-token' }
  state.auditRows = []
  fetchCalls = []
  resetRateLimit()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/* ════════════════════════════ GET ════════════════════════════ */

describe('GET /api/google/gmail', () => {
  it('401s when there is no app session', async () => {
    state.session = null
    const res = await GET(getReq())
    expect(res.status).toBe(401)
  })

  it('401s with { reauth: true } when the Google token is missing (resolveGoogleAuth, real)', async () => {
    state.token = null
    const res = await GET(getReq())
    expect(res.status).toBe(401)
    expect((await res.json()).reauth).toBe(true)
  })

  it('401s with { reauth: true } when the token refresh failed upstream', async () => {
    state.token = { accessToken: 'x', error: 'RefreshAccessTokenError' }
    const res = await GET(getReq())
    expect(res.status).toBe(401)
    expect((await res.json()).reauth).toBe(true)
  })

  it('returns a parsed single thread (decoded body, headers, unread flag) for ?threadId=', async () => {
    stubGmail([
      ['/threads/t1?format=full', {
        id: 't1',
        messages: [{
          id: 'm1',
          threadId: 't1',
          labelIds: ['UNREAD'],
          snippet: 'snip',
          payload: {
            headers: [
              { name: 'From', value: 'a@x.com' },
              { name: 'Subject', value: 'Hello' },
              { name: 'Message-ID', value: '<mid-1>' },
            ],
            body: { data: b64('plain body text') },
          },
        }],
      }],
    ])
    const res = await GET(getReq('?threadId=t1'))
    expect(res.status).toBe(200)
    const { thread } = await res.json()
    expect(thread.id).toBe('t1')
    expect(thread.messages[0]).toMatchObject({
      from: 'a@x.com',
      subject: 'Hello',
      body: '<div style="white-space:pre-wrap">plain body text</div>',
      isUnread: true,
      inReplyTo: '<mid-1>',
    })
  })

  it('prefers text/html (even nested in multipart), then text/plain escaped, then the snippet', async () => {
    stubGmail([
      ['/threads/t2?format=full', {
        id: 't2',
        messages: [
          {
            // multipart/alternative nested inside multipart/mixed — the HTML
            // part must win so designed emails render as authored.
            id: 'm0', threadId: 't2',
            payload: { parts: [
              { mimeType: 'multipart/alternative', parts: [
                { mimeType: 'text/plain', body: { data: b64('plain alt') } },
                { mimeType: 'text/html', body: { data: b64('<h1>Designed</h1>') } },
              ] },
            ] },
          },
          {
            id: 'm1', threadId: 't2',
            payload: { parts: [{ mimeType: 'text/plain', body: { data: b64('part <body>') } }] },
          },
          { id: 'm2', threadId: 't2', snippet: 'only snippet' },
        ],
      }],
    ])
    const { thread } = await (await GET(getReq('?threadId=t2'))).json()
    expect(thread.messages[0].body).toBe('<h1>Designed</h1>')
    // Plain text is HTML-escaped and newline-preserving so it renders safely.
    expect(thread.messages[1].body).toBe('<div style="white-space:pre-wrap">part &lt;body&gt;</div>')
    expect(thread.messages[2].body).toBe('only snippet')
  })

  it('lists inbox threads with metadata, drops per-thread failures, and reports the label unread count', async () => {
    stubGmail([
      // thread list (INBOX default view)
      ['/threads?labelIds=INBOX', { threads: [{ id: 'a', snippet: 's' }, { id: 'b', snippet: 's' }] }],
      ['/threads/a?format=metadata', {
        id: 'a',
        messages: [{ id: 'am', threadId: 'a', labelIds: ['UNREAD'], snippet: 'sa', payload: { headers: [{ name: 'Subject', value: 'A subj' }] } }],
      }],
      // thread b's metadata fetch fails — must be filtered out, not fatal
      ['/threads/b?format=metadata', () => new Error('500')],
      ['/threads?labelIds=UNREAD', { threads: [{}] }],
      ['/labels/INBOX', { messagesUnread: 7 }],
    ])
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.threads).toHaveLength(1)
    expect(json.threads[0].subject).toBe('A subj')
    expect(json.unreadCount).toBe(7)
  })

  it('maps view=sent to the SENT label and clamps maxResults into 1..100', async () => {
    stubGmail([['/threads?labelIds=SENT', { threads: [] }]])
    const res = await GET(getReq('?view=sent&maxResults=9999'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ threads: [], unreadCount: 0, nextPageToken: null })
    expect(fetchCalls[0].url).toContain('labelIds=SENT&maxResults=100')
  })

  it('passes a valid pageToken through, returns nextPageToken, and skips the unread count on paged requests', async () => {
    stubGmail([
      ['/threads?labelIds=INBOX', { threads: [{ id: 'a', snippet: 's' }], nextPageToken: 'tok-2' }],
      ['/threads/a?format=metadata', { id: 'a', messages: [{ id: 'm', threadId: 'a', payload: { headers: [] } }] }],
    ])
    const res = await GET(getReq('?view=inbox&maxResults=50&pageToken=tok-1'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.nextPageToken).toBe('tok-2')
    expect(json.unreadCount).toBe(0)
    expect(fetchCalls[0].url).toContain('pageToken=tok-1')
    // Paged requests must not re-fetch the unread count / label endpoints.
    expect(fetchCalls.some(c => c.url.includes('labelIds=UNREAD') || c.url.includes('/labels/INBOX'))).toBe(false)
  })

  it('drops a malformed pageToken instead of forwarding it to Gmail', async () => {
    stubGmail([
      ['/threads?labelIds=INBOX', { threads: [] }],
    ])
    const res = await GET(getReq(`?view=inbox&pageToken=${encodeURIComponent('bad token!<>')}`))
    expect(res.status).toBe(200)
    expect(fetchCalls[0].url).not.toContain('pageToken')
  })

  it('treats an unread-count failure as non-fatal (threads still returned, count 0)', async () => {
    stubGmail([
      ['/threads?labelIds=INBOX', { threads: [{ id: 'a', snippet: 's' }] }],
      ['/threads/a?format=metadata', { id: 'a', messages: [{ id: 'm', threadId: 'a', payload: { headers: [] } }] }],
      ['/threads?labelIds=UNREAD', () => new Error('503')],
    ])
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.threads).toHaveLength(1)
    expect(json.unreadCount).toBe(0)
  })

  it('maps an upstream Gmail 401 to a 401 { reauth: true } (googleApiErrorResponse, real)', async () => {
    stubGmail([['/threads?labelIds=INBOX', () => new Error('401')]])
    const res = await GET(getReq())
    expect(res.status).toBe(401)
    expect((await res.json()).reauth).toBe(true)
  })

  it('maps an upstream Gmail 500 to a 502 (transient upstream)', async () => {
    stubGmail([['/threads?labelIds=INBOX', () => new Error('500')]])
    const res = await GET(getReq())
    expect(res.status).toBe(502)
  })
})

/* ════════════════════════════ POST ════════════════════════════ */

const VALID = { to: 'ops@rxfitatx.com', subject: 'Weekly', message: 'body text' }

function stubSendOk() {
  stubGmail([
    ['/messages/send', { id: 'msg-1', threadId: 'thr-1' }],
    ['/modify', {}],
  ])
}

describe('POST /api/google/gmail — auth + gate', () => {
  it('401s when there is no app session', async () => {
    state.session = null
    const res = await POST(postReq(VALID))
    expect(res.status).toBe(401)
  })

  it('403s an AI-marked send with NO gate token (fail closed, real verifier)', async () => {
    stubSendOk()
    const res = await POST(postReq(VALID, { 'x-ai-intent': 'send_gmail' }))
    expect(res.status).toBe(403)
    expect(fetchCalls).toHaveLength(0) // never reached Gmail
  })

  it('403s when the declared intent is not permitted on this route', async () => {
    stubSendOk()
    const token = issueGateToken('post_chat_message', 95)
    const res = await POST(postReq(VALID, { 'x-ai-intent': 'post_chat_message', 'x-gate-token': token }))
    expect(res.status).toBe(403)
  })

  it('403s when the signed token intent does not match the declared intent', async () => {
    stubSendOk()
    // Token signed for chat, declared as send_gmail — forged intent swap.
    const token = issueGateToken('post_chat_message', 95)
    const res = await POST(postReq(VALID, { 'x-ai-intent': 'send_gmail', 'x-gate-token': token }))
    expect(res.status).toBe(403)
  })

  it('403s an expired gate token', async () => {
    stubSendOk()
    const token = issueGateToken('send_gmail', 95, Date.now() - 10 * 60 * 1000)
    const res = await POST(postReq(VALID, { 'x-ai-intent': 'send_gmail', 'x-gate-token': token }))
    expect(res.status).toBe(403)
  })

  it('lets a manual (no AI marker) send through with no gate token and writes NO audit row', async () => {
    stubSendOk()
    const res = await POST(postReq(VALID))
    expect(res.status).toBe(200)
    expect((await res.json())).toMatchObject({ sent: true, messageId: 'msg-1' })
    expect(state.auditRows).toHaveLength(0)
  })
})

describe('POST /api/google/gmail — validation', () => {
  it('400s on invalid JSON', async () => {
    const res = await POST(postReq('{not json'))
    expect(res.status).toBe(400)
  })

  it('400s on a schema violation (empty message)', async () => {
    const res = await POST(postReq({ to: 'a@b.co', message: '' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Validation failed')
  })

  it('400s an invalid recipient address (#25 EMAIL_RE)', async () => {
    const res = await POST(postReq({ ...VALID, to: 'not-an-address' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid recipient address')
  })

  it('rejects a quoted display name containing a comma (fails closed at the route layer)', async () => {
    const res = await POST(postReq({ ...VALID, to: '"Lopez, Maria" <m@x.com>' }))
    expect(res.status).toBe(400)
  })

  it('accepts a comma-separated list of Name <addr> recipients and normalizes them', async () => {
    stubSendOk()
    const res = await POST(postReq({ ...VALID, to: 'Ops <ops@rxfitatx.com>, danny@rxfitatx.com' }))
    expect(res.status).toBe(200)
    const raw = decodeRaw(JSON.parse(String(fetchCalls[0].init?.body)).raw)
    expect(raw).toContain('To: ops@rxfitatx.com, danny@rxfitatx.com')
  })
})

describe('POST /api/google/gmail — RFC-2822 assembly (decoded from the real raw payload)', () => {
  it('strips CR/LF from the subject so headers cannot be injected', async () => {
    stubSendOk()
    const res = await POST(postReq({ ...VALID, subject: 'Hi\r\nBcc: evil@x.com' }))
    expect(res.status).toBe(200)
    const raw = decodeRaw(JSON.parse(String(fetchCalls[0].init?.body)).raw)
    expect(raw).toContain('Subject: Hi Bcc: evil@x.com') // folded onto ONE line
    expect(raw).not.toMatch(/^Bcc:/m) // no injected header line
  })

  it('falls back to "Re: <inReplyTo>" when replying without a subject', async () => {
    stubSendOk()
    const res = await POST(postReq({ to: 'a@b.co', message: 'm', inReplyTo: '<mid-9>', subject: '' }))
    expect(res.status).toBe(200)
    const raw = decodeRaw(JSON.parse(String(fetchCalls[0].init?.body)).raw)
    expect(raw).toContain('Subject: Re: <mid-9>')
    expect(raw).toContain('In-Reply-To: <mid-9>')
    expect(raw).toContain('References: <mid-9>')
  })

  it('falls back to "(no subject)" when neither subject nor inReplyTo is given', async () => {
    stubSendOk()
    await POST(postReq({ to: 'a@b.co', message: 'm' }))
    const raw = decodeRaw(JSON.parse(String(fetchCalls[0].init?.body)).raw)
    expect(raw).toContain('Subject: (no subject)')
  })

  it('threads the reply (payload.threadId) and marks the thread read, swallowing modify failures', async () => {
    stubGmail([
      ['/messages/send', { id: 'msg-2', threadId: 'thr-2' }],
      ['/modify', () => new Error('500')], // mark-read fails — must NOT fail the send
    ])
    const res = await POST(postReq({ ...VALID, threadId: 'thr-2' }))
    expect(res.status).toBe(200)
    expect(JSON.parse(String(fetchCalls[0].init?.body)).threadId).toBe('thr-2')
    const modifyCall = fetchCalls.find(c => c.url.includes('/modify'))
    expect(modifyCall?.url).toContain('/threads/thr-2/modify')
    expect(JSON.parse(String(modifyCall?.init?.body)).removeLabelIds).toEqual(['UNREAD'])
  })
})

describe('POST /api/google/gmail — AI audit + rate limit (NS-2)', () => {
  const aiHeaders = () => ({
    'x-ai-intent': 'send_gmail',
    'x-gate-token': issueGateToken('send_gmail', 95),
  })

  it('writes exactly one success audit row with routing metadata only (never subject/body)', async () => {
    stubSendOk()
    const res = await POST(postReq({ ...VALID, threadId: 'thr-1' }, aiHeaders()))
    expect(res.status).toBe(200)
    expect(state.auditRows).toHaveLength(1)
    const row = state.auditRows[0]
    expect(row).toMatchObject({
      actor: 'ai',
      actionType: 'gmail_send',
      status: 'success',
      userEmail: 'danny@rxfitatx.com',
      intent: 'send_gmail',
      target: { to: 'ops@rxfitatx.com', threadId: 'thr-1' },
    })
    expect(JSON.stringify(row.target)).not.toContain('Weekly')
    expect(JSON.stringify(row.target)).not.toContain('body text')
  })

  it('writes a failed audit row (with the error) and maps the status when Gmail rejects the send', async () => {
    stubGmail([['/messages/send', () => new Error('500')]])
    const res = await POST(postReq(VALID, aiHeaders()))
    expect(res.status).toBe(502)
    expect(state.auditRows).toHaveLength(1)
    expect(state.auditRows[0].status).toBe('failed')
    expect(String(state.auditRows[0].error)).toContain('500')
  })

  it('429s with Retry-After AND writes a rate_limited audit row once the real gmail_send window is breached', async () => {
    stubSendOk()
    const limit = ACTION_LIMITS.gmail_send // 5
    for (let i = 0; i < limit; i++) {
      const ok = await POST(postReq(VALID, aiHeaders()))
      expect(ok.status).toBe(200)
    }
    const res = await POST(postReq(VALID, aiHeaders()))
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(state.auditRows).toHaveLength(limit + 1)
    const breach = state.auditRows[limit]
    expect(breach).toMatchObject({ status: 'failed', error: 'rate_limited' })
    // The breached request never reached Gmail.
    expect(fetchCalls.filter(c => c.url.includes('/messages/send'))).toHaveLength(limit)
  })

  it('does NOT rate-limit or audit manual sends (no AI marker) past the AI window', async () => {
    stubSendOk()
    for (let i = 0; i < ACTION_LIMITS.gmail_send + 2; i++) {
      const res = await POST(postReq(VALID))
      expect(res.status).toBe(200)
    }
    expect(state.auditRows).toHaveLength(0)
  })
})
