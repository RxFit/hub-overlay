import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   KPI surface — auth / RBAC guard behavior on the two KPI routes.

   These exercise only the early-exit guard/validation branches (401 / 403 / 400
   / onboarding-empty) which return BEFORE any Paperclip or DB access, so no
   network or database harness is needed. Mirrors tests/chat-route.test.ts.
   ════════════════════════════════════════════════════════════════════════════ */

// Mutable session the mocked getServerSession returns; set per test.
const { state } = vi.hoisted(() => ({ state: { session: null as unknown } }))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => state.session),
}))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))

import { GET as kpisGET } from '@/app/api/kpis/route'
import { GET as settingsKpisGET, POST as settingsKpisPOST } from '@/app/api/settings/kpis/route'

function sessionWithRole(role: string) {
  return { user: { email: 'u@example.com', role } }
}

beforeEach(() => {
  state.session = null
})

describe('GET /api/kpis — auth guard', () => {
  it('returns 401 when there is no session', async () => {
    state.session = null
    const res = await kpisGET(new NextRequest('http://localhost/api/kpis'))
    expect(res.status).toBe(401)
  })

  it('returns an empty KPI set for the onboarding role without hitting Paperclip', async () => {
    state.session = sessionWithRole('onboarding')
    const res = await kpisGET(new NextRequest('http://localhost/api/kpis'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ kpis: [], projects: [] })
  })
})

describe('POST /api/settings/kpis — admin-only guard', () => {
  function postReq(body: unknown) {
    return new NextRequest('http://localhost/api/settings/kpis', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('returns 401 when unauthenticated', async () => {
    state.session = null
    const res = await settingsKpisPOST(postReq({ label: 'Revenue' }))
    expect(res.status).toBe(401)
  })

  it('returns 403 for a non-admin (staff) caller', async () => {
    state.session = sessionWithRole('staff')
    const res = await settingsKpisPOST(postReq({ label: 'Revenue' }))
    expect(res.status).toBe(403)
  })

  it('returns 403 for the onboarding role', async () => {
    state.session = sessionWithRole('onboarding')
    const res = await settingsKpisPOST(postReq({ label: 'Revenue' }))
    expect(res.status).toBe(403)
  })

  it('lets an admin through the guard but rejects a missing label with 400', async () => {
    state.session = sessionWithRole('admin')
    const res = await settingsKpisPOST(postReq({}))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/label/i)
  })
})

describe('GET /api/settings/kpis — onboarding disclosure guard (P1)', () => {
  function getReq() {
    return new NextRequest('http://localhost/api/settings/kpis')
  }

  it('401s when unauthenticated', async () => {
    state.session = null
    expect((await settingsKpisGET(getReq())).status).toBe(401)
  })

  it('returns an empty set for onboarding — parity with /api/kpis, no staff-KPI leak', async () => {
    // The bug: non-admins got visibility='staff' rows and onboarding was never
    // excluded — chained with open sign-up this disclosed business KPIs.
    state.session = sessionWithRole('onboarding')
    const res = await settingsKpisGET(getReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: [], source: 'db' })
  })

  it('returns an empty set for an unknown/sub-staff role (fail closed)', async () => {
    state.session = sessionWithRole('guest')
    const res = await settingsKpisGET(getReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: [], source: 'db' })
  })
})
