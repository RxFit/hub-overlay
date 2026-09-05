import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * GET /api/execution/pulse — route contract (Phase 4 PR 1).
 *
 * The middleware does not role-guard this path, so the handler's session
 * check is the ONLY gate. Role does not gate the route (staff see their own
 * actions and deep runs) but it MUST reach the reader as `isAdmin`, because
 * that flag is what withholds the ai_runs + dispatch planes.
 */

const { sessionMock, snapshotMock, adminMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  snapshotMock: vi.fn(),
  adminMock: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: sessionMock }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/roles', () => ({ canAccessAdminRoute: adminMock }))
vi.mock('@/lib/execution-context', () => ({ readExecutionSnapshot: snapshotMock }))

import { GET } from '@/app/api/execution/pulse/route'
import { NextRequest } from 'next/server'

const req = () => new NextRequest('http://localhost:3000/api/execution/pulse')

beforeEach(() => {
  sessionMock.mockReset()
  snapshotMock.mockReset()
  adminMock.mockReset()
})

describe('GET /api/execution/pulse', () => {
  it('401s without a session and never reads', async () => {
    sessionMock.mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(snapshotMock).not.toHaveBeenCalled()
  })

  it('serves a staff user their own scope with isAdmin=false', async () => {
    sessionMock.mockResolvedValue({ user: { email: 'staff@rxfitatx.com', role: 'staff' } })
    adminMock.mockReturnValue(false)
    snapshotMock.mockResolvedValue({ runs: null, dispatch: null, actions: { total: 0, failed: 0, recent: [] }, toolRuns: { active: 0, recent: [] }, notices: [], generatedAt: 'x' })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(snapshotMock).toHaveBeenCalledWith({ userEmail: 'staff@rxfitatx.com', isAdmin: false })
    const body = await res.json()
    expect(body.snapshot.runs).toBeNull()
  })

  it('passes isAdmin=true for an admin', async () => {
    sessionMock.mockResolvedValue({ user: { email: 'danny@rxfitatx.com', role: 'superadmin' } })
    adminMock.mockReturnValue(true)
    snapshotMock.mockResolvedValue({ notices: [] })
    await GET(req())
    expect(snapshotMock).toHaveBeenCalledWith({ userEmail: 'danny@rxfitatx.com', isAdmin: true })
  })
})
