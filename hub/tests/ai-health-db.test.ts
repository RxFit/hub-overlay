import { it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import {
  describeDb,
  migrateTestDb,
  resetDb,
  seedTelemetryEvent,
  seedAiAction,
  closeDb,
} from '../test/db-harness'

/* ════════════════════════════════════════════════════════════════════════════
   DB-BACKED /api/admin/ai-health (NS-10).

   Real telemetry rows in a real `event_log` + real `ai_action_log` rows,
   exercised through the actual route handler: the 401/403/400 auth/param
   matrix, exact aggregate values against seeded fixtures, window filtering,
   and alert evaluation over persisted data.

   Gated with describeDb — skips locally without DATABASE_URL, runs in CI.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({ state: { session: null as unknown } }))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => state.session),
}))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))

import { GET } from '@/app/api/admin/ai-health/route'

const ADMIN = { user: { email: 'danny@rxfitatx.com', role: 'admin' } }
const STAFF = { user: { email: 'staffer@rxfitatx.com', role: 'staff' } }

function req(qs = '') {
  return new NextRequest(`http://localhost/api/admin/ai-health${qs}`)
}

function at(minutesAgo: number): Date {
  return new Date(Date.now() - minutesAgo * 60_000)
}

describeDb('GET /api/admin/ai-health — DB-backed', () => {
  beforeAll(() => {
    migrateTestDb()
  })

  beforeEach(async () => {
    await resetDb()
    state.session = ADMIN
  })

  afterAll(async () => {
    await closeDb()
  })

  /* ── Auth / param matrix ── */

  it('401 when unauthenticated', async () => {
    state.session = null
    const res = await GET(req())
    expect(res.status).toBe(401)
  })

  it('403 for a non-admin role — the API enforces the role itself (middleware does not cover /api/admin/*)', async () => {
    state.session = STAFF
    const res = await GET(req())
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.requests).toBeUndefined()
  })

  it('400 for a window outside the 1h|24h|7d whitelist', async () => {
    for (const bad of ['?window=banana', '?window=2h', '?window=']) {
      const res = await GET(req(bad))
      expect(res.status).toBe(400)
    }
  })

  it('200 for superadmin too', async () => {
    state.session = { user: { email: 'danny@rxfitatx.com', role: 'superadmin' } }
    const res = await GET(req())
    expect(res.status).toBe(200)
  })

  /* ── Aggregates against seeded fixtures ── */

  it('aggregates seeded telemetry + action rows exactly (default 24h window)', async () => {
    await seedTelemetryEvent({
      eventType: 'telemetry:ai_complete',
      payload: { type: 'ai_complete', ms: 100, provider: 'claude', model: 'm1' },
      correlationId: 'r1',
      createdAt: at(60),
    })
    await seedTelemetryEvent({
      eventType: 'telemetry:ai_complete',
      payload: { type: 'ai_complete', ms: 300, provider: 'gemini', model: 'm2' },
      correlationId: 'r2',
      createdAt: at(50),
    })
    await seedTelemetryEvent({
      eventType: 'telemetry:ai_error',
      payload: { type: 'ai_error', code: 'auth', provider: 'gemini' },
      correlationId: 'r3',
      createdAt: at(40),
    })
    await seedTelemetryEvent({
      eventType: 'telemetry:ai_timeout',
      payload: { type: 'ai_timeout', layer: 'connect', provider: 'gemini', model: 'm2' },
      correlationId: 'r3',
      createdAt: at(41),
    })
    await seedTelemetryEvent({
      eventType: 'telemetry:ai_fallback',
      payload: { type: 'ai_fallback', from: 'claude', to: 'gemini', reason: 'error' },
      correlationId: 'r2',
      createdAt: at(51),
    })
    // A NON-telemetry event_log row must be ignored by the aggregate.
    await seedTelemetryEvent({
      eventType: 'kpi.synced',
      payload: { anything: true },
      createdAt: at(30),
    })
    await seedAiAction({ userEmail: 'danny@rxfitatx.com', actionType: 'gmail_send', status: 'success', createdAt: at(20) })
    await seedAiAction({ userEmail: 'danny@rxfitatx.com', actionType: 'chat_post', status: 'failed', error: 'rate_limited', createdAt: at(10) })

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.window).toBe('24h')
    expect(body.requests).toBe(3) // 2 completes + 1 error — fallback/timeout/kpi rows don't count
    expect(body.successRate).toBeCloseTo(2 / 3, 10)
    expect(body.fallbacks).toBe(1)
    expect(body.fallbackRate).toBeCloseTo(1 / 3, 10)
    expect(body.timeouts).toBe(1)
    expect(body.timeoutsByLayer).toEqual({ connect: 1 })
    expect(body.errorsByCode).toEqual({ auth: 1 })
    expect(body.latencyMs).toEqual({ p50: 100, p95: 300 })
    expect(body.actions).toEqual({
      total: 2,
      byType: { gmail_send: 1, chat_post: 1 },
      byStatus: { success: 1, failed: 1 },
    })
    expect(body.rateLimited).toBe(1)

    // Recent failures: the failed action (newest) then the ai_error.
    expect(body.recentFailures.map((f: { kind: string; code: string }) => [f.kind, f.code])).toEqual([
      ['action_failed', 'rate_limited'],
      ['ai_error', 'auth'],
    ])

    // fallback rate 1/3 > 0.25 → warn; success 2/3 < 0.9 → critical.
    expect(body.alerts.map((a: { id: string; severity: string }) => `${a.id}:${a.severity}`).sort()).toEqual([
      'fallback_rate:warn',
      'success_rate:critical',
    ])
  })

  it('respects the window: ?window=1h excludes older rows that 24h includes', async () => {
    await seedTelemetryEvent({
      eventType: 'telemetry:ai_complete',
      payload: { type: 'ai_complete', ms: 50, provider: 'claude', model: 'm' },
      createdAt: at(10), // inside 1h
    })
    await seedTelemetryEvent({
      eventType: 'telemetry:ai_error',
      payload: { type: 'ai_error', code: 'old' },
      createdAt: at(120), // outside 1h, inside 24h
    })
    await seedAiAction({ userEmail: 'danny@rxfitatx.com', createdAt: at(90) }) // outside 1h

    const narrow = await (await GET(req('?window=1h'))).json()
    expect(narrow.window).toBe('1h')
    expect(narrow.requests).toBe(1)
    expect(narrow.successRate).toBe(1)
    expect(narrow.errorsByCode).toEqual({})
    expect(narrow.actions.total).toBe(0)

    const wide = await (await GET(req('?window=24h'))).json()
    expect(wide.requests).toBe(2)
    expect(wide.errorsByCode).toEqual({ old: 1 })
    expect(wide.actions.total).toBe(1)
  })

  it('returns a clean empty aggregate (nulls, no NaN, no alerts) for an empty window', async () => {
    const res = await GET(req('?window=7d'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.requests).toBe(0)
    expect(body.successRate).toBeNull()
    expect(body.fallbackRate).toBeNull()
    expect(body.latencyMs).toEqual({ p50: null, p95: null })
    expect(body.alerts).toEqual([])
    expect(JSON.stringify(body)).not.toContain('NaN')
  })

  it('sink round-trip: emit() with TELEMETRY_DB_SINK=on persists a row the endpoint then aggregates', async () => {
    const saved = process.env.TELEMETRY_DB_SINK
    process.env.TELEMETRY_DB_SINK = 'on'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { emit } = await import('@/lib/observability')
      emit({ type: 'ai_complete', requestId: 'round-trip-1', ms: 777, provider: 'claude', model: 'sonnet' })
      // Fire-and-forget: poll until the row lands (bounded).
      await vi.waitFor(async () => {
        const body = await (await GET(req('?window=1h'))).json()
        expect(body.requests).toBe(1)
        expect(body.latencyMs.p50).toBe(777)
      }, { timeout: 5000 })
    } finally {
      logSpy.mockRestore()
      if (saved === undefined) delete process.env.TELEMETRY_DB_SINK
      else process.env.TELEMETRY_DB_SINK = saved
    }
  })
})
