import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * /api/execution/queue + /api/execution/queue/dismiss — route contracts
 * (Phase 4 PR 2). The middleware does not role-guard these paths, so the
 * handlers' session checks are the ONLY gate. Role does not gate the queue
 * (staff have their own items) but MUST reach the reader as `isAdmin`.
 * Dismiss keys are validated against the closed grammar.
 */

const { sessionMock, readMock, adminMock, dismissMock, undismissMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  readMock: vi.fn(),
  adminMock: vi.fn(),
  dismissMock: vi.fn(),
  undismissMock: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: sessionMock }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/roles', () => ({ canAccessAdminRoute: adminMock }))
vi.mock('@/lib/needs-you', () => ({ readNeedsYou: readMock }))
vi.mock('@/lib/tenant-context', () => ({ getTenantId: () => 'rxfit' }))
vi.mock('@/lib/queue-dismissals', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queue-dismissals')>('@/lib/queue-dismissals')
  return { isItemKey: actual.isItemKey, ITEM_KEY_RE: actual.ITEM_KEY_RE, dismissItem: dismissMock, undismissItem: undismissMock }
})

import { GET } from '@/app/api/execution/queue/route'
import { POST } from '@/app/api/execution/queue/dismiss/route'

const listReq = () => new NextRequest('http://localhost:3000/api/execution/queue')
const dismissReq = (body: unknown) =>
  new NextRequest('http://localhost:3000/api/execution/queue/dismiss', { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  sessionMock.mockReset(); readMock.mockReset(); adminMock.mockReset(); dismissMock.mockReset(); undismissMock.mockReset()
})

describe('GET /api/execution/queue', () => {
  it('401s without a session and never reads', async () => {
    sessionMock.mockResolvedValue(null)
    expect((await GET(listReq())).status).toBe(401)
    expect(readMock).not.toHaveBeenCalled()
  })

  it('serves staff their own scope with isAdmin=false, and admins with isAdmin=true', async () => {
    sessionMock.mockResolvedValue({ user: { email: 'staff@rxfitatx.com', role: 'staff' } })
    adminMock.mockReturnValue(false)
    readMock.mockResolvedValue({ items: [], dismissedCount: 0, notices: [] })
    const res = await GET(listReq())
    expect(res.status).toBe(200)
    expect(readMock).toHaveBeenCalledWith({ userEmail: 'staff@rxfitatx.com', isAdmin: false })
    expect(await res.json()).toEqual({ items: [], dismissedCount: 0, notices: [] })

    sessionMock.mockResolvedValue({ user: { email: 'danny@rxfitatx.com', role: 'superadmin' } })
    adminMock.mockReturnValue(true)
    await GET(listReq())
    expect(readMock).toHaveBeenLastCalledWith({ userEmail: 'danny@rxfitatx.com', isAdmin: true })
  })
})

describe('POST /api/execution/queue/dismiss', () => {
  it('401s without a session', async () => {
    sessionMock.mockResolvedValue(null)
    expect((await POST(dismissReq({ key: 'run:abc' }))).status).toBe(401)
    expect(dismissMock).not.toHaveBeenCalled()
  })

  it('rejects keys outside the closed grammar (free text can never reach the table)', async () => {
    sessionMock.mockResolvedValue({ user: { email: 'd@x' } })
    for (const key of ['abc', 'run:', 'run:with space', 'thing:1', 'run:' + 'x'.repeat(65), 42, null]) {
      expect((await POST(dismissReq({ key }))).status).toBe(400)
    }
    expect((await POST(new NextRequest('http://localhost:3000/api/execution/queue/dismiss', { method: 'POST', body: '{' }))).status).toBe(400)
    expect(dismissMock).not.toHaveBeenCalled()
  })

  it('dismisses in the caller\'s scope, and undoes with undo:true', async () => {
    sessionMock.mockResolvedValue({ user: { email: 'D@rxfitatx.com' } })
    dismissMock.mockResolvedValue(undefined)
    undismissMock.mockResolvedValue(undefined)
    const res = await POST(dismissReq({ key: 'deep:11111111-2222-4333-8444-555555555555' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, key: 'deep:11111111-2222-4333-8444-555555555555', dismissed: true })
    expect(dismissMock).toHaveBeenCalledWith('rxfit', 'D@rxfitatx.com', 'deep:11111111-2222-4333-8444-555555555555')

    const undo = await POST(dismissReq({ key: 'alert:e1', undo: true }))
    expect((await undo.json()).dismissed).toBe(false)
    expect(undismissMock).toHaveBeenCalledWith('rxfit', 'D@rxfitatx.com', 'alert:e1')
  })
})
