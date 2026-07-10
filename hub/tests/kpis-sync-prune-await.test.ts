import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/kpis/sync — retention prunes run to completion (P2).

   The prunes were launched un-awaited right before the response; on scale-to-
   zero serverless the instance can freeze after responding, so they may never
   finish. The fix awaits them (Promise.allSettled) before returning. We make
   each prune resolve on a macrotask: if it were fire-and-forget the response
   would resolve first and the completion flags would still be false.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: { user: { email: 'danny@rxfitatx.com', role: 'admin' } } as unknown,
    memDone: false,
    logDone: false,
    memReject: false,
  },
}))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => state.session),
}))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/google-session', () => ({
  resolveGoogleAuth: vi.fn(async () => ({ ok: true, accessToken: 'tok' })),
}))
vi.mock('@/lib/kpi-sources', () => ({
  runAllSources: vi.fn(async () => ({
    kpis: [{ id: 'x', label: 'Test', source: 'stripe', rawValue: 1, trend: '', trendDirection: 'neutral', unit: null }],
    sources: { ga4: { count: 1 }, gsc: { count: 1 }, stripe: { count: 1 } },
  })),
}))
vi.mock('@/lib/db', () => ({
  db: {
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  },
  withTransaction: vi.fn(async () => 1),
}))
vi.mock('@/lib/event-logger', () => ({ recordEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/tenant-context', () => ({ getTenantId: () => 'rxfit' }))
vi.mock('@/lib/agent-memory', () => ({
  pruneExpiredMemories: vi.fn(
    () =>
      new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          if (state.memReject) return reject(new Error('boom'))
          state.memDone = true
          resolve()
        }, 5),
      ),
  ),
  pruneOldEventLogs: vi.fn(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          state.logDone = true
          resolve()
        }, 5),
      ),
  ),
}))

import { POST } from '@/app/api/kpis/sync/route'

function req() {
  return new NextRequest('http://localhost/api/kpis/sync', { method: 'POST' })
}

beforeEach(() => {
  state.session = { user: { email: 'danny@rxfitatx.com', role: 'admin' } }
  state.memDone = false
  state.logDone = false
  state.memReject = false
  delete process.env.CRON_SECRET
})

describe('POST /api/kpis/sync — prune await', () => {
  it('awaits both prunes to completion before responding', async () => {
    const res = await POST(req())
    expect(res.status).toBe(200)
    // If the prunes were fire-and-forget, these macrotask flags would still be
    // false at the moment the response resolved.
    expect(state.memDone).toBe(true)
    expect(state.logDone).toBe(true)
  })

  it('a prune failure does not fail the sync (allSettled)', async () => {
    state.memReject = true
    const res = await POST(req())
    expect(res.status).toBe(200)
    // The other prune still completes.
    expect(state.logDone).toBe(true)
  })
})
