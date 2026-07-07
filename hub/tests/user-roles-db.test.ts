import { it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  describeDb,
  migrateTestDb,
  resetDb,
  getSql,
  closeDb,
} from '../test/db-harness'
import {
  ensureTenant,
  getUserRole,
  upsertUserRole,
  getAllRoleEntries,
} from '@/lib/userRoles'

/* ════════════════════════════════════════════════════════════════════════════
   DB-BACKED lib/userRoles (NS-8).

   userRoles is the RBAC source of truth (`hub_users` table) — every request's
   role/project assignment flows through getUserRole. This suite exercises the
   real Postgres paths: the onboarding default for unknown users, email
   normalization, the upsert's insert-vs-update branch (unique tenant+email),
   and tenant scoping.

   Gated with describeDb — skips locally without DATABASE_URL, runs in CI.
   ════════════════════════════════════════════════════════════════════════════ */

const TENANT = 'rxfit'

describeDb('lib/userRoles — DB-backed', () => {
  beforeAll(() => {
    migrateTestDb()
  })

  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('defaults an UNKNOWN user to onboarding with no projects', async () => {
    const role = await getUserRole('nobody@rxfitatx.com', TENANT)
    expect(role).toEqual({ role: 'onboarding', assignedProjects: [] })
  })

  it('upsert INSERTS a new user and getUserRole finds them (email normalized)', async () => {
    await upsertUserRole(
      {
        email: '  Danny@RxFitATX.com ',
        role: 'admin',
        assignedProjects: ['c1', 'c2'],
        assignedBy: 'system',
        name: 'Danny',
      },
      TENANT,
    )

    // Lookup with a differently-cased email must hit the same row.
    const role = await getUserRole('danny@rxfitatx.com', TENANT)
    expect(role).toEqual({ role: 'admin', assignedProjects: ['c1', 'c2'] })

    const rows = await getSql()<{ email: string; name: string }[]>`
      SELECT email, name FROM hub_users WHERE tenant_id = ${TENANT}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('danny@rxfitatx.com') // stored lowercased/trimmed
    expect(rows[0].name).toBe('Danny')
  })

  it('upsert UPDATES on conflict — same tenant+email never duplicates', async () => {
    await upsertUserRole(
      { email: 'staff@rxfitatx.com', role: 'staff', assignedProjects: ['c1'], assignedBy: 'admin' },
      TENANT,
    )
    await upsertUserRole(
      {
        email: 'STAFF@rxfitatx.com',
        role: 'admin',
        assignedProjects: ['*'],
        assignedBy: 'superadmin',
      },
      TENANT,
    )

    const role = await getUserRole('staff@rxfitatx.com', TENANT)
    expect(role).toEqual({ role: 'admin', assignedProjects: ['*'] })

    const [{ count }] = await getSql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM hub_users WHERE tenant_id = ${TENANT}
    `
    expect(count).toBe('1')
  })

  it('getAllRoleEntries returns mapped entries scoped to the tenant', async () => {
    await upsertUserRole(
      { email: 'a@rxfitatx.com', role: 'admin', assignedProjects: [], assignedBy: 'sys' },
      TENANT,
    )
    await upsertUserRole(
      { email: 'b@rxfitatx.com', role: 'staff', assignedProjects: ['c9'], assignedBy: 'sys' },
      TENANT,
    )
    // A user in a DIFFERENT tenant must not appear.
    await ensureTenant('other-tenant', 'Other Co')
    await upsertUserRole(
      { email: 'c@other.com', role: 'staff', assignedProjects: [], assignedBy: 'sys' },
      'other-tenant',
    )

    const entries = await getAllRoleEntries(TENANT)
    expect(entries.map((e) => e.email).sort()).toEqual(['a@rxfitatx.com', 'b@rxfitatx.com'])

    const b = entries.find((e) => e.email === 'b@rxfitatx.com')!
    expect(b.role).toBe('staff')
    expect(b.assignedProjects).toEqual(['c9'])
    expect(b.assignedBy).toBe('sys')
    expect(Number.isNaN(Date.parse(b.assignedAt))).toBe(false)
  })

  it('ensureTenant is idempotent and does not clobber an existing tenant', async () => {
    await ensureTenant(TENANT, 'Renamed!')
    const [row] = await getSql()<{ name: string }[]>`
      SELECT name FROM tenants WHERE id = ${TENANT}
    `
    // ON CONFLICT DO NOTHING — the seed name survives.
    expect(row.name).toBe('RxFit Athletics')
  })

  it('auto-creates an unseen tenant on lookup and still defaults to onboarding', async () => {
    // getUserRole calls ensureTenant first, so a lookup against a brand-new
    // tenant id must not FK-fail — the tenant row is created on the fly.
    const role = await getUserRole('x@y.com', 'brand-new-tenant')
    expect(role).toEqual({ role: 'onboarding', assignedProjects: [] })
    const [row] = await getSql()<{ id: string }[]>`
      SELECT id FROM tenants WHERE id = 'brand-new-tenant'
    `
    expect(row.id).toBe('brand-new-tenant')
  })
})
