import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * /api/deep-runs/availability — the honest-availability read (PR D).
 *
 * Locks: the staff gate; the three truthful states (dispatch disabled,
 * worker stale, worker fresh); and the never-500 contract — a store read
 * failure reports available:false, because to the chips "offline by error"
 * and "offline in fact" must render the same honest way.
 */

const { sessionMock, staffMock, storeMock, dispatchMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  staffMock: vi.fn(),
  storeMock: {
    workerFresh: vi.fn(),
    isMissingTableError: (err: unknown) => (err as { code?: string } | null)?.code === '42P01',
  },
  dispatchMock: {
    dispatchFreshMs: () => 45_000,
    isDispatchConfigured: vi.fn(),
    isDispatchEnabled: vi.fn(),
  },
}))

vi.mock('next-auth', () => ({ getServerSession: sessionMock }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/roles', () => ({ canAccessStaffRoute: staffMock }))
vi.mock('@/lib/dispatch-store', () => storeMock)
vi.mock('@/lib/agy-dispatch', () => dispatchMock)

import { GET } from '@/app/api/deep-runs/availability/route'

beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ user: { email: 'staff@rxfitatx.com', role: 'staff' } })
  staffMock.mockReset().mockReturnValue(true)
  storeMock.workerFresh.mockReset().mockResolvedValue(true)
  dispatchMock.isDispatchConfigured.mockReset().mockReturnValue(true)
  dispatchMock.isDispatchEnabled.mockReset().mockReturnValue(true)
})

describe('GET /api/deep-runs/availability', () => {
  it('401s without a session; 403s below staff', async () => {
    sessionMock.mockResolvedValue(null)
    expect((await GET()).status).toBe(401)
    sessionMock.mockResolvedValue({ user: { email: 'x@rxfitatx.com', role: 'onboarding' } })
    staffMock.mockReturnValue(false)
    expect((await GET()).status).toBe(403)
  })

  it('reports live when dispatch is on and the worker heartbeat is fresh', async () => {
    const body = await (await GET()).json()
    expect(body).toEqual({ available: true, reason: null, workerFresh: true })
  })

  it('reports dispatch_disabled without touching the store', async () => {
    dispatchMock.isDispatchEnabled.mockReturnValue(false)
    const body = await (await GET()).json()
    expect(body).toEqual({ available: false, reason: 'dispatch_disabled', workerFresh: false })
    expect(storeMock.workerFresh).not.toHaveBeenCalled()
  })

  it('reports no_worker when the heartbeat is stale', async () => {
    storeMock.workerFresh.mockResolvedValue(false)
    const body = await (await GET()).json()
    expect(body).toEqual({ available: false, reason: 'no_worker', workerFresh: false })
  })

  it('a store read failure degrades to offline — never a 500 into the chips', async () => {
    storeMock.workerFresh.mockRejectedValue(Object.assign(new Error('no table'), { code: '42P01' }))
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).available).toBe(false)
  })
})
