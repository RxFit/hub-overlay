import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/google/chat/messages — route-owned logic (NS-11).

   Mocking boundary: next-auth session/JWT + `lib/google` (Chat REST adapter).
   Real: the gate (`requireAiGate` + HMAC tokens), zod validation, the
   MISSING_SCOPE 403 carve-out that must run BEFORE the generic error mapper,
   the NS-2 audit contract, and the real chat_post rate limiter.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    token: null as unknown,
    auditRows: [] as Record<string, unknown>[],
    listChatMessagesPage: vi.fn(),
    sendChatMessage: vi.fn(),
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
vi.mock('@/lib/google', () => ({
  listChatMessagesPage: (...a: unknown[]) => state.listChatMessagesPage(...a),
  sendChatMessage: (...a: unknown[]) => state.sendChatMessage(...a),
}))

process.env.NEXTAUTH_SECRET = 'test-gate-secret'

import { GET, POST } from '@/app/api/google/chat/messages/route'
import { issueGateToken } from '@/lib/gateToken'
import { _reset as resetRateLimit, ACTION_LIMITS } from '@/lib/rate-limit'

function getReq(qs = '') {
  return new NextRequest(`http://localhost/api/google/chat/messages${qs}`)
}
function postReq(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/google/chat/messages', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })
}

beforeEach(() => {
  state.session = { user: { email: 'danny@rxfitatx.com' } }
  state.token = { accessToken: 'goog-token' }
  state.auditRows = []
  state.listChatMessagesPage.mockReset()
  state.sendChatMessage.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  resetRateLimit()
})

describe('GET /api/google/chat/messages', () => {
  it('401s { reauth: true } when the Google token is missing', async () => {
    state.token = null
    const res = await GET(getReq('?spaceId=spaces/x'))
    expect(res.status).toBe(401)
    expect((await res.json()).reauth).toBe(true)
  })

  it('400s when spaceId is missing', async () => {
    const res = await GET(getReq())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Missing spaceId')
  })

  it('returns messages + continuation token, forwarding spaceId and pageSize', async () => {
    state.listChatMessagesPage.mockResolvedValue({ messages: [{ name: 'm1' }], nextPageToken: 'older-1' })
    const res = await GET(getReq('?spaceId=spaces/x&pageSize=25'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ messages: [{ name: 'm1' }], nextPageToken: 'older-1' })
    expect(state.listChatMessagesPage).toHaveBeenCalledWith('goog-token', 'spaces/x', 25, {
      threadName: undefined,
      pageToken: undefined,
    })
  })

  it('forwards pageToken so "Show earlier messages" continues the listing', async () => {
    state.listChatMessagesPage.mockResolvedValue({ messages: [] })
    await GET(getReq('?spaceId=spaces/x&pageToken=older-1'))
    expect(state.listChatMessagesPage).toHaveBeenCalledWith('goog-token', 'spaces/x', 50, {
      threadName: undefined,
      pageToken: 'older-1',
    })
  })

  it('forwards a well-formed threadName so the thread view gets the FULL thread', async () => {
    state.listChatMessagesPage.mockResolvedValue({ messages: [] })
    const res = await GET(getReq('?spaceId=spaces/x&threadName=' + encodeURIComponent('spaces/x/threads/t1')))
    expect(res.status).toBe(200)
    expect(state.listChatMessagesPage).toHaveBeenCalledWith('goog-token', 'spaces/x', 50, {
      threadName: 'spaces/x/threads/t1',
      pageToken: undefined,
    })
  })

  it('drops a malformed threadName instead of letting it reach Google as a filter', async () => {
    state.listChatMessagesPage.mockResolvedValue({ messages: [] })
    await GET(getReq('?spaceId=spaces/x&threadName=' + encodeURIComponent('spaces/x/threads/t1" OR x')))
    expect(state.listChatMessagesPage).toHaveBeenCalledWith('goog-token', 'spaces/x', 50, {
      threadName: undefined,
      pageToken: undefined,
    })
  })

  it('keeps the dedicated 403 MISSING_SCOPE contract for a missing Chat scope (before the generic mapper)', async () => {
    state.listChatMessagesPage.mockRejectedValue(new Error('Google API error 403: insufficientPermissions'))
    const res = await GET(getReq('?spaceId=spaces/x'))
    expect(res.status).toBe(403) // NOT folded into a reauth 401
    expect((await res.json()).code).toBe('MISSING_SCOPE')
  })

  it('maps other upstream failures through the generic mapper (500 → 502)', async () => {
    state.listChatMessagesPage.mockRejectedValue(new Error('Google API error 500: boom'))
    const res = await GET(getReq('?spaceId=spaces/x'))
    expect(res.status).toBe(502)
  })
})

describe('POST /api/google/chat/messages', () => {
  const VALID = { spaceId: 'spaces/x', text: '  hello team  ' }
  const aiHeaders = () => ({
    'x-ai-intent': 'post_chat_message',
    'x-gate-token': issueGateToken('post_chat_message', 95),
  })

  it('403s an AI-marked post without a gate token (fail closed)', async () => {
    const res = await POST(postReq(VALID, { 'x-ai-intent': 'post_chat_message' }))
    expect(res.status).toBe(403)
    expect(state.sendChatMessage).not.toHaveBeenCalled()
  })

  it('403s a declared intent this route does not allow', async () => {
    const token = issueGateToken('send_gmail', 95)
    const res = await POST(postReq(VALID, { 'x-ai-intent': 'send_gmail', 'x-gate-token': token }))
    expect(res.status).toBe(403)
  })

  it('400s a schema violation (empty text)', async () => {
    const res = await POST(postReq({ spaceId: 'spaces/x', text: '   ' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Validation failed')
  })

  it('posts a manual message with trimmed text and writes NO audit row', async () => {
    state.sendChatMessage.mockResolvedValue({ name: 'msg-1' })
    const res = await POST(postReq({ ...VALID, threadKey: 'tk' }))
    expect(res.status).toBe(200)
    expect((await res.json()).message).toEqual({ name: 'msg-1' })
    expect(state.sendChatMessage).toHaveBeenCalledWith('goog-token', 'spaces/x', 'hello team', {
      threadName: undefined,
      threadKey: 'tk',
    })
    expect(state.auditRows).toHaveLength(0)
  })

  it('posts a plain message with NO thread target at all', async () => {
    state.sendChatMessage.mockResolvedValue({ name: 'msg-plain' })
    const res = await POST(postReq(VALID))
    expect(res.status).toBe(200)
    expect(state.sendChatMessage).toHaveBeenCalledWith('goog-token', 'spaces/x', 'hello team', undefined)
  })

  it('forwards threadName so a reply lands INSIDE the thread it answers', async () => {
    state.sendChatMessage.mockResolvedValue({ name: 'msg-reply' })
    const res = await POST(postReq({ ...VALID, threadName: 'spaces/x/threads/t1' }))
    expect(res.status).toBe(200)
    expect(state.sendChatMessage).toHaveBeenCalledWith('goog-token', 'spaces/x', 'hello team', {
      threadName: 'spaces/x/threads/t1',
      threadKey: undefined,
    })
  })

  it('400s a malformed threadName (quotes/spaces can never reach Google routing)', async () => {
    const res = await POST(postReq({ ...VALID, threadName: 'spaces/x/threads/bad id"' }))
    expect(res.status).toBe(400)
    expect(state.sendChatMessage).not.toHaveBeenCalled()
  })

  it('audits an AI post success with routing metadata only (spaceId/thread, never the text)', async () => {
    state.sendChatMessage.mockResolvedValue({ name: 'msg-2' })
    const res = await POST(postReq({ ...VALID, threadName: 'spaces/x/threads/t1', threadKey: 'tk' }, aiHeaders()))
    expect(res.status).toBe(200)
    expect(state.auditRows).toHaveLength(1)
    expect(state.auditRows[0]).toMatchObject({
      actor: 'ai',
      actionType: 'chat_post',
      status: 'success',
      userEmail: 'danny@rxfitatx.com',
      target: { spaceId: 'spaces/x', threadName: 'spaces/x/threads/t1', threadKey: 'tk' },
    })
    expect(JSON.stringify(state.auditRows[0].target)).not.toContain('hello team')
  })

  it('audits an AI post failure and maps the upstream status', async () => {
    state.sendChatMessage.mockRejectedValue(new Error('Google API error 500: down'))
    const res = await POST(postReq(VALID, aiHeaders()))
    expect(res.status).toBe(502)
    expect(state.auditRows).toHaveLength(1)
    expect(state.auditRows[0].status).toBe('failed')
    expect(String(state.auditRows[0].error)).toContain('500')
  })

  it('429s + audits rate_limited at the real chat_post window; the breach never reaches Google', async () => {
    state.sendChatMessage.mockResolvedValue({ name: 'm' })
    const limit = ACTION_LIMITS.chat_post // 10
    for (let i = 0; i < limit; i++) {
      expect((await POST(postReq(VALID, aiHeaders()))).status).toBe(200)
    }
    const res = await POST(postReq(VALID, aiHeaders()))
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(state.auditRows[limit]).toMatchObject({ status: 'failed', error: 'rate_limited' })
    expect(state.sendChatMessage).toHaveBeenCalledTimes(limit)
  })
})
