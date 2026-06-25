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

    const json = await res.json()
    expect(json.error).toBe('Chat request failed')
    expect(typeof json.details).toBe('string')
    expect(json.details).toContain('JWTDecodeError')

    expect(errorSpy).toHaveBeenCalled()  // structured log emitted
  })
})
