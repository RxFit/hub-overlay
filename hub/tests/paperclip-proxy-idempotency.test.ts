import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * P1 — Idempotency-Key must be STABLE across every upstream attempt.
 *
 * buildFetchOpts() is invoked per attempt (initial call, 401 re-auth retry, and
 * each withRetry retry). Previously it minted a FRESH crypto.randomUUID() each
 * time, so a write that committed upstream but returned a retryable 5xx would
 * retry with a DIFFERENT key → Paperclip could not dedupe → duplicate write.
 * The fix computes ONE deterministic key per logical request and reuses it, so
 * the header value is identical on every attempt.
 */

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({
    user: { email: 'danny@rxfitatx.com', role: 'superadmin', assignedProjects: ['*'] },
  })),
}))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('@/lib/paperclipConfig', () => ({ PAPERCLIP_BASE_URL: 'https://paperclip.test' }))
vi.mock('@/lib/paperclipSession', () => ({
  getPaperclipAuthHeaders: vi.fn(async () => ({ Cookie: 'session=abc' })),
  clearPaperclipSession: vi.fn(),
}))
vi.mock('@/lib/loop-detector', () => ({
  loopDetector: { detectAndRecord: vi.fn() },
}))
vi.mock('@/lib/tenant-context', () => ({ getTenantId: () => 'tenant-test' }))
// Use the REAL withRetry / circuit-breaker so the retry path actually executes.

import { PATCH } from '@/app/api/paperclip/[...path]/route'
import { NextRequest } from 'next/server'

function keyOf(call: unknown): string | undefined {
  const opts = (call as [string, RequestInit])[1]
  const headers = opts.headers as Record<string, string>
  // Header keys are lower-cased by Object.fromEntries(new Headers()).
  return headers['idempotency-key'] ?? headers['Idempotency-Key']
}

describe('paperclip proxy — idempotency key stability across retries', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends an IDENTICAL Idempotency-Key on every attempt when a write retries after a 503', async () => {
    const okResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      // First attempt: retryable 503 (write may have committed upstream).
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      // Retry attempt: success.
      .mockResolvedValueOnce(okResponse)

    const req = new NextRequest('https://hub.test/api/paperclip/agents/abc123', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })

    const res = await PATCH(req, { params: { path: ['agents', 'abc123'] } })
    expect(res.status).toBe(200)

    // Two attempts total: the 503 then the successful retry.
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const firstKey = keyOf(fetchMock.mock.calls[0])
    const secondKey = keyOf(fetchMock.mock.calls[1])

    expect(firstKey).toBeTruthy()
    expect(secondKey).toBe(firstKey)
  })

  it('does not attach an Idempotency-Key to GET (read) requests', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

    const { GET } = await import('@/app/api/paperclip/[...path]/route')
    const req = new NextRequest('https://hub.test/api/paperclip/agents/abc123', { method: 'GET' })
    await GET(req, { params: { path: ['agents', 'abc123'] } })

    expect(keyOf(fetchMock.mock.calls[0])).toBeUndefined()
  })
})
