import { describe, it, expect, vi, beforeEach } from 'vitest'

// getServerSession throws → exercises the F1 try/catch wrapper.
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => { throw new Error('JWTDecodeError: secret rotated') }),
}))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => null) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
// Keep logs quiet but assert error was logged. Hoisted so the spy exists
// before the (hoisted) vi.mock factory runs during module load.
const { errorSpy } = vi.hoisted(() => ({ errorSpy: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: errorSpy, debug: vi.fn() }),
}))

import { POST } from '@/app/api/chat/route'
import { NextRequest } from 'next/server'

describe('POST /api/chat — pre-stream error handling (F1)', () => {
  beforeEach(() => errorSpy.mockClear())

  it('returns a JSON 500 (not an opaque framework error) when auth throws', async () => {
    const req = new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      headers: { 'Content-Type': 'application/json' },
    })

    const res = await POST(req)          // must resolve, never reject
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    expect(res.headers.get('x-hub-fault-id')).toMatch(/^HUB-[A-Z2-7]{8}$/)

    const json = await res.json()
    // faultResponse's body now, not lib/chat-error.ts's — that module is gone.
    // Both keys useChatEngine reads survive: it takes `details`, falling back
    // to `error`.
    expect(json.error).toBe('Something went wrong. Please try again.')
    expect(typeof json.details).toBe('string')
    expect(json.details).toContain('JWTDecodeError')
    expect(json.instance).toBe(res.headers.get('x-hub-fault-id'))

    // THE REGRESSION THIS LOCKS DOWN. /api/chat is middleware-excluded, so no
    // inbound x-hub-request-id exists. Any catch here that calls safeRequestId()
    // itself mints a SECOND id and records the fault under one the response
    // never shows — measured at 44b6abe7-… in the record vs d8dd8c23-… on the
    // response before this was fixed. One derivation, withFault's, is what
    // keeps a quoted id findable in the logs.
    expect(json.requestId).toBe(res.headers.get('x-hub-request-id'))

    expect(errorSpy).toHaveBeenCalled()  // structured log emitted
  })
})
