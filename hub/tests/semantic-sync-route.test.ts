import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * /api/cron/semantic-sync — route contract.
 *
 * /api/cron/ is middleware-excluded (a scheduler holds no NextAuth cookie), so
 * the constant-time CRON_SECRET check is the ONLY gate — locked here like
 * dispatch-alert-route.test.ts. The sync engine itself is covered offline in
 * lib/semantic-sync/*.test.ts; here it is mocked so the test pins the
 * route's gate, input validation and status mapping.
 */

const runMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/semantic-sync', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/semantic-sync')>()),
  runSemanticSync: runMock,
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import { POST } from '@/app/api/cron/semantic-sync/route'

const ORIGINAL_SECRET = process.env.CRON_SECRET

function request(secret?: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/semantic-sync', {
    method: 'POST',
    ...(secret !== undefined ? { headers: { 'x-cron-secret': secret } } : {}),
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
}

beforeEach(() => {
  runMock.mockReset().mockResolvedValue([
    { source: 'stripe', status: 'synced', documents: 3, durationMs: 5 },
    { source: 'gmail', status: 'not_configured', missing: ['SEMANTIC_SYNC_GMAIL_SUBJECT'], durationMs: 0 },
  ])
  process.env.CRON_SECRET = 'shh'
})

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = ORIGINAL_SECRET
})

describe('POST /api/cron/semantic-sync', () => {
  it('503s when CRON_SECRET is unset (kill switch), without syncing anything', async () => {
    delete process.env.CRON_SECRET
    expect((await POST(request('shh'))).status).toBe(503)
    expect(runMock).not.toHaveBeenCalled()
  })

  it('401s on a wrong or missing secret', async () => {
    expect((await POST(request('nope'))).status).toBe(401)
    expect((await POST(request())).status).toBe(401)
    expect(runMock).not.toHaveBeenCalled()
  })

  it('runs every source, cursor-driven, when the scheduler sends no body', async () => {
    const res = await POST(request('shh'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, dryRun: false })
    expect(body.sources.map((s: { status: string }) => s.status)).toEqual(['synced', 'not_configured'])
    const opts = runMock.mock.calls[0][0]
    expect(opts.sources).toBeUndefined()
    expect(opts.lookbackHours).toBeUndefined()
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('passes a validated backfill / dry-run request through', async () => {
    await POST(request('shh', { sources: ['gmail'], dryRun: true, lookbackHours: 72, maxItems: 50 }))
    expect(runMock.mock.calls[0][0]).toMatchObject({ sources: ['gmail'], dryRun: true, lookbackHours: 72, maxItems: 50 })
  })

  it.each([
    ['not JSON', 'nope{'],
    ['an unknown source', { sources: ['drive'] }],
    ['a lookback past Stripe retention', { lookbackHours: 24 * 31 }],
    ['an unknown key', { force: true }],
  ])('400s on %s without syncing', async (_label, body) => {
    expect((await POST(request('shh', body))).status).toBe(400)
    expect(runMock).not.toHaveBeenCalled()
  })

  it('502s when any source failed, so the scheduled run fails loudly', async () => {
    runMock.mockResolvedValue([
      { source: 'stripe', status: 'synced', durationMs: 1 },
      { source: 'gmail', status: 'failed', failure: { stage: 'auth', detail: 'unauthorized_client' }, durationMs: 1 },
    ])
    const res = await POST(request('shh'))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.sources[1].failure.stage).toBe('auth')
  })
})
