import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/chat/score-context — lazy Gemini client (P2).

   The Gemini fallback client must be constructed at call time (reading the key
   at runtime), not at module load — otherwise a key injected after import
   yields a client built with an empty string. This mirrors detect-intent and
   lib/vector-store getGenAI(). We assert the GoogleGenerativeAI constructor is
   NOT invoked merely by importing the route, nor on paths that never reach the
   Gemini fallback.
   ════════════════════════════════════════════════════════════════════════════ */

const { ctorSpy, state } = vi.hoisted(() => ({
  ctorSpy: vi.fn(),
  state: { session: { user: { email: 'danny@rxfitatx.com' } } as unknown },
}))

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    constructor(key: string) {
      ctorSpy(key)
    }
    getGenerativeModel() {
      return { generateContent: async () => ({ response: { text: () => '{}' } }) }
    }
  },
}))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => state.session),
}))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))

import { POST } from '@/app/api/chat/score-context/route'

function req(body: unknown) {
  return new NextRequest('http://localhost/api/chat/score-context', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  ctorSpy.mockClear()
  state.session = { user: { email: 'danny@rxfitatx.com' } }
})

describe('score-context lazy Gemini client', () => {
  it('does NOT construct the Gemini client at module import', () => {
    // The import above already ran; if the client were eager it would have
    // called the constructor by now.
    expect(ctorSpy).not.toHaveBeenCalled()
  })

  it('does not construct the client on a read-only auto-pass intent', async () => {
    const res = await POST(req({ intent: 'view_runs', context: { scope: 'all' } }))
    expect(res.status).toBe(200)
    expect(ctorSpy).not.toHaveBeenCalled()
  })

  it('does not construct the client on the zero-answer baseline path', async () => {
    const res = await POST(req({ intent: 'create_task', context: {} }))
    expect(res.status).toBe(200)
    expect(ctorSpy).not.toHaveBeenCalled()
  })
})
