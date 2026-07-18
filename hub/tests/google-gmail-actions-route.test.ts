import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/google/gmail/actions — the action-menu write endpoint (trash /
   save-to-Google-Task).

   Mocking boundary mirrors google-gmail-route.test.ts: only next-auth's
   session/JWT readers and the global fetch aimed at Google are stubbed;
   route-owned logic (zod validation, thread-id guard, gate contract, audit)
   runs REAL.
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

process.env.NEXTAUTH_SECRET = 'test-gate-secret'

import { POST } from '@/app/api/google/gmail/actions/route'

const realFetch = global.fetch

function postReq(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/google/gmail/actions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

/** Stub Google API calls: returns [urlSubstring, response] pairs. */
function stubGoogle(routes: [string, unknown][]) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const [substr, payload] of routes) {
      if (url.includes(substr)) {
        return new Response(JSON.stringify(payload), { status: 200 })
      }
    }
    return new Response('not stubbed', { status: 500 })
  }) as typeof fetch
}

beforeEach(() => {
  state.session = { user: { email: 'danny@rxfitatx.com' } }
  state.token = { accessToken: 'tok' }
  state.auditRows = []
})

afterEach(() => {
  global.fetch = realFetch
  vi.clearAllMocks()
})

describe('POST /api/google/gmail/actions', () => {
  it('401s with no session', async () => {
    state.session = null
    const res = await POST(postReq({ action: 'trash', threadId: 't1' }))
    expect(res.status).toBe(401)
  })

  it('400s on invalid JSON and on schema violations', async () => {
    const bad = new NextRequest('http://localhost/api/google/gmail/actions', {
      method: 'POST',
      body: 'not json',
    })
    expect((await POST(bad)).status).toBe(400)
    expect((await POST(postReq({ action: 'nuke', threadId: 't1' }))).status).toBe(400)
    expect((await POST(postReq({ action: 'trash' }))).status).toBe(400)
  })

  it('rejects path-injection thread ids before any Google call', async () => {
    const spy = vi.fn()
    global.fetch = spy as unknown as typeof fetch
    const res = await POST(postReq({ action: 'trash', threadId: '../labels' }))
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('trash: POSTs to the Gmail trash endpoint and reports ok', async () => {
    stubGoogle([['/threads/t42/trash', { id: 't42' }]])
    const res = await POST(postReq({ action: 'trash', threadId: 't42' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, action: 'trash', threadId: 't42' })
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(call[0])).toContain('/threads/t42/trash')
    expect(call[1]?.method).toBe('POST')
  })

  it('save_task: resolves title/notes from SERVER-fetched thread metadata (not the client body) and creates the task in @default', async () => {
    stubGoogle([
      // Server-side provenance: the route must fetch the real thread metadata.
      ['/threads/t42?format=metadata', {
        id: 't42',
        messages: [{
          id: 'm1', threadId: 't42', snippet: 'SBG helps small operators',
          payload: { headers: [
            { name: 'From', value: 'Sarah Allen <sarah@x.com>' },
            { name: 'Subject', value: 'Re: rx fit capital?' },
            { name: 'Date', value: 'Fri, 18 Jul 2026' },
          ] },
        }],
      }],
      ['tasks.googleapis.com/tasks/v1/lists/@default/tasks', { id: 'task-9' }],
    ])
    const res = await POST(postReq({
      action: 'save_task',
      threadId: 't42',
      // Client-supplied fields are spoofed — the server-fetched values must win.
      subject: 'FORGED SUBJECT',
      from: 'Forged Sender <evil@x.com>',
      snippet: 'forged snippet',
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, action: 'save_task', taskId: 'task-9' })
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(String(calls[0][0])).toContain('/threads/t42?format=metadata')
    const taskCall = calls.find(c => String(c[0]).includes('tasks.googleapis.com'))
    const sent = JSON.parse(String(taskCall?.[1]?.body))
    expect(sent.title).toBe('Re: rx fit capital?')
    expect(sent.notes).toContain('Sarah Allen')
    expect(sent.notes).not.toContain('FORGED')
    expect(sent.notes).toContain('Preview: SBG helps small operators')
    expect(sent.notes).toContain('mail.google.com')
  })

  it('manual taps are NOT audited; AI-marked calls without a gate token are rejected', async () => {
    stubGoogle([['/threads/t1/trash', {}]])
    await POST(postReq({ action: 'trash', threadId: 't1' }))
    expect(state.auditRows).toHaveLength(0)

    // AI marker without a valid gate token → gate failure, no Google call.
    const spy = vi.fn()
    global.fetch = spy as unknown as typeof fetch
    const res = await POST(postReq(
      { action: 'trash', threadId: 't1' },
      { 'X-AI-Intent': 'gmail_trash' }
    ))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('maps upstream Gmail failures through googleApiErrorResponse', async () => {
    global.fetch = vi.fn(async () => new Response('boom', { status: 403 })) as typeof fetch
    const res = await POST(postReq({ action: 'trash', threadId: 't1' }))
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})
