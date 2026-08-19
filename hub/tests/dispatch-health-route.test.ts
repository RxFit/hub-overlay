import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * /api/admin/dispatch-health — route contract.
 *
 * The middleware deliberately does not role-guard /api/admin/*, so this
 * handler's session + admin check is the ONLY gate — locked here exactly like
 * agy-health-route.test.ts. Also locks: the cheap default report runs no
 * probe job, probe=1 spends one and reports marker verification, and typed
 * error classes surface instead of stack text.
 */

const { sessionMock, adminMock, dispatchMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  adminMock: vi.fn(),
  dispatchMock: vi.fn(),
}))
const storeMock = vi.hoisted(() => ({
  reapExpired: vi.fn().mockResolvedValue(undefined),
  sweepStale: vi.fn().mockResolvedValue(undefined),
  listWorkers: vi.fn().mockResolvedValue([]),
  queueDepths: vi.fn().mockResolvedValue({}),
  listRecentJobs: vi.fn().mockResolvedValue([]),
  isMissingTableError: (err: unknown) => (err as { code?: string } | null)?.code === '42P01',
}))

vi.mock('next-auth', () => ({ getServerSession: sessionMock }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/roles', () => ({ canAccessAdminRoute: adminMock }))
vi.mock('@/lib/dispatch-store', () => storeMock)
vi.mock('@/lib/runs', () => ({ recordAiRun: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/agy', () => ({
  agyErrorType: (err: unknown) => (err as { agyError?: { type?: string } })?.agyError?.type ?? 'unknown',
  truncateAgyError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}))
vi.mock('@/lib/agy-dispatch', () => ({
  dispatchGenerateText: dispatchMock,
  isDispatchEnabled: () => true,
  isDispatchConfigured: () => true,
  dispatchFreshMs: () => 45_000,
}))

import { GET } from '@/app/api/admin/dispatch-health/route'

function request(path = '/api/admin/dispatch-health'): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`)
}

beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ user: { email: 'admin@rxfitatx.com', role: 'admin' } })
  adminMock.mockReset().mockReturnValue(true)
  dispatchMock.mockReset()
  storeMock.listWorkers.mockResolvedValue([])
})

describe('GET /api/admin/dispatch-health', () => {
  it('401s without a session', async () => {
    sessionMock.mockResolvedValue(null)
    expect((await GET(request())).status).toBe(401)
  })

  it('403s for non-admin roles without touching the store', async () => {
    adminMock.mockReturnValue(false)
    expect((await GET(request())).status).toBe(403)
    expect(storeMock.listWorkers).not.toHaveBeenCalled()
  })

  it('cheap default report: no probe job is enqueued', async () => {
    storeMock.listWorkers.mockResolvedValue([
      { id: 'danny-desktop', lastSeenAt: new Date(), version: 'abc', agyVersion: '1.1.12' },
    ])
    const res = await GET(request())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.workerAlive).toBe(true)
    expect(body.workers[0].fresh).toBe(true)
    expect(body.probe).toEqual({ ran: false })
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  it('missing tables degrade to tablesReady:false, not a 500', async () => {
    storeMock.listWorkers.mockRejectedValue(Object.assign(new Error('no table'), { code: '42P01' }))
    const body = await (await GET(request())).json()
    expect(body.tablesReady).toBe(false)
    expect(body.healthy).toBe(false)
  })

  it('probe=1 round-trips a marker job and reports verification', async () => {
    dispatchMock.mockResolvedValue({
      text: 'AGY_DISPATCH_OK',
      model: 'gemini-3-flash',
      raw: { workerId: 'danny-desktop' },
      latencyMs: 4_200,
      usage: {},
    })
    const body = await (await GET(request('/api/admin/dispatch-health?probe=1'))).json()
    expect(dispatchMock).toHaveBeenCalledOnce()
    expect(body.probe).toMatchObject({ ran: true, ok: true, markerVerified: true, workerId: 'danny-desktop' })
  })

  it('probe failure surfaces the typed class and flips healthy', async () => {
    dispatchMock.mockRejectedValue(
      Object.assign(new Error('no worker'), { agyError: { type: 'no_worker', message: 'no worker' } }),
    )
    const body = await (await GET(request('/api/admin/dispatch-health?probe=1'))).json()
    expect(body.probe).toMatchObject({ ran: true, ok: false, errorClass: 'no_worker' })
    expect(body.healthy).toBe(false)
  })
})
