import { it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import {
  describeDb,
  migrateTestDb,
  resetDb,
  seedKpi,
  getSql,
  closeDb,
} from '../test/db-harness'

/* ════════════════════════════════════════════════════════════════════════════
   DB-BACKED EXEMPLAR (NS-3).

   The companion suite tests/kpi-routes.test.ts covers only the early-exit
   auth/RBAC guards (401/403/400) that return BEFORE any DB access. THIS suite
   proves the disposable-Postgres harness: it inserts real fixtures and asserts
   the /api/settings/kpis route's actual query + insert behavior against a live
   database.

   Gating: the whole suite is `describeDb` — it runs ONLY when a test DB is
   present (DATABASE_URL set, as in CI). Locally, with no DB, it SKIPS cleanly
   so `npm test` stays green. This is the pattern NS-2's audit endpoint and
   future DB-backed route tests should copy. See hub/docs/testing-db.md.
   ════════════════════════════════════════════════════════════════════════════ */

// Mutable session the mocked getServerSession returns; set per test.
const { state } = vi.hoisted(() => ({ state: { session: null as unknown } }))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => state.session),
}))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))

import { GET as kpisGET, POST as kpisPOST } from '@/app/api/settings/kpis/route'

function adminSession() {
  return { user: { email: 'admin@example.com', role: 'admin' } }
}

function postReq(body: unknown) {
  return new NextRequest('http://localhost/api/settings/kpis', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

describeDb('POST/GET /api/settings/kpis — DB-backed', () => {
  beforeAll(() => {
    migrateTestDb()
  })

  beforeEach(async () => {
    await resetDb()
    state.session = adminSession()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('POST inserts a KPI row that is really persisted in Postgres', async () => {
    const res = await kpisPOST(
      postReq({ label: 'Monthly Revenue', value: '42000', visibility: 'staff' }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.created).toBe(true)
    expect(json.row.label).toBe('Monthly Revenue')
    expect(json.row.value).toBe('42000')

    // Assert the row is actually in the DB (not just echoed back).
    const rows = await getSql()<{ label: string; value: string }[]>`
      SELECT label, value FROM kpis WHERE id = ${json.row.id}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe('Monthly Revenue')
  })

  it('GET returns tenant-scoped rows and hides non-staff KPIs from non-admins', async () => {
    // Seed one staff-visible and one admin-only KPI for the rxfit tenant.
    await seedKpi({ label: 'Public Metric', visibility: 'staff' })
    await seedKpi({ label: 'Secret Metric', visibility: 'admin' })

    // Admin sees both.
    state.session = adminSession()
    const adminRes = await kpisGET(
      new NextRequest('http://localhost/api/settings/kpis'),
    )
    expect(adminRes.status).toBe(200)
    const adminJson = await adminRes.json()
    expect(adminJson.source).toBe('db')
    const adminLabels = adminJson.rows.map((r: { label: string }) => r.label).sort()
    expect(adminLabels).toEqual(['Public Metric', 'Secret Metric'])

    // A staff (non-admin) caller sees only the staff-visible KPI.
    state.session = { user: { email: 'staff@example.com', role: 'staff' } }
    const staffRes = await kpisGET(
      new NextRequest('http://localhost/api/settings/kpis'),
    )
    expect(staffRes.status).toBe(200)
    const staffJson = await staffRes.json()
    const staffLabels = staffJson.rows.map((r: { label: string }) => r.label)
    expect(staffLabels).toEqual(['Public Metric'])
  })

  it('resetDb truncates between tests — no rows leak from the prior test', async () => {
    state.session = adminSession()
    const res = await kpisGET(new NextRequest('http://localhost/api/settings/kpis'))
    const json = await res.json()
    expect(json.rows).toEqual([])
  })
})
