import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   GET /api/ai-actions — auth matrix for the audit-trail read endpoint (NS-2).

   No DB harness has landed yet (NS-3), so the repository layer (listAiActions)
   is mocked — this exercises the auth/RBAC + query-scoping logic (401 / self /
   admin-other / non-admin-other) without a real database.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: { session: null as unknown, lastArgs: null as { userEmail: string; limit: number } | null },
}))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => state.session),
}))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/ai-audit', () => ({
  listAiActions: vi.fn(async (opts: { userEmail: string; limit: number }) => {
    state.lastArgs = opts
    return [{ id: '1', userEmail: opts.userEmail, actionType: 'gmail_send', status: 'success' }]
  }),
}))

import { GET } from '@/app/api/ai-actions/route'

function sessionFor(email: string | null, role: string) {
  return email ? { user: { email, role } } : null
}
function req(qs = '') {
  return new NextRequest(`http://localhost/api/ai-actions${qs}`)
}

beforeEach(() => {
  state.session = null
  state.lastArgs = null
})

describe('GET /api/ai-actions — auth matrix', () => {
  it('returns 401 when unauthenticated', async () => {
    state.session = null
    const res = await GET(req())
    expect(res.status).toBe(401)
  })

  it('returns 401 when the session has no email', async () => {
    state.session = { user: { role: 'admin' } }
    const res = await GET(req())
    expect(res.status).toBe(401)
  })

  it('returns the caller\'s own actions by default (scoped to self)', async () => {
    state.session = sessionFor('danny@rxfitatx.com', 'staff')
    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.actions).toHaveLength(1)
    expect(state.lastArgs?.userEmail).toBe('danny@rxfitatx.com')
  })

  it('ignores ?user when it equals self (still scoped to self, no admin needed)', async () => {
    state.session = sessionFor('danny@rxfitatx.com', 'staff')
    const res = await GET(req('?user=Danny@RxFitATX.com'))
    expect(res.status).toBe(200)
    expect(state.lastArgs?.userEmail).toBe('danny@rxfitatx.com')
  })

  it('lets an admin read another user\'s actions via ?user', async () => {
    state.session = sessionFor('admin@rxfitatx.com', 'admin')
    const res = await GET(req('?user=someone@rxfitatx.com'))
    expect(res.status).toBe(200)
    expect(state.lastArgs?.userEmail).toBe('someone@rxfitatx.com')
  })

  it('lets a superadmin read another user\'s actions via ?user', async () => {
    state.session = sessionFor('root@rxfitatx.com', 'superadmin')
    const res = await GET(req('?user=someone@rxfitatx.com'))
    expect(res.status).toBe(200)
    expect(state.lastArgs?.userEmail).toBe('someone@rxfitatx.com')
  })

  it('returns 403 when a non-admin requests another user via ?user', async () => {
    state.session = sessionFor('danny@rxfitatx.com', 'staff')
    const res = await GET(req('?user=someone@rxfitatx.com'))
    expect(res.status).toBe(403)
    expect(state.lastArgs).toBeNull() // never reached the repository
  })

  it('clamps limit to the 1..200 range', async () => {
    state.session = sessionFor('danny@rxfitatx.com', 'staff')
    await GET(req('?limit=9999'))
    expect(state.lastArgs?.limit).toBe(200)
    await GET(req('?limit=0'))
    expect(state.lastArgs?.limit).toBe(1)
    await GET(req('?limit=25'))
    expect(state.lastArgs?.limit).toBe(25)
  })
})
