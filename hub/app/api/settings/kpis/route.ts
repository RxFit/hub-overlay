import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { eq, and } from 'drizzle-orm'
import { db } from '@/lib/db'
import { kpis, tenants } from '@/lib/schema'
import { getTenantId } from '@/lib/tenant-context'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

// Phase 1 (multi-tenancy): resolved per-request via getTenantId().
// When middleware sets x-tenant-id from hostname, this will auto-resolve.

/** Ensure the tenant row exists (idempotent) */
async function ensureTenant(tenantId: string) {
  await db
    .insert(tenants)
    .values({ id: tenantId, name: 'RxFit Athletics', domain: 'rxfit.co' })
    .onConflictDoNothing()
}

/**
 * GET /api/settings/kpis
 * Returns all KPI rows for the current tenant from Postgres.
 */
export const GET = withFault('settings/kpis', async (_req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // P1: `onboarding` (and any sub-staff / unknown role) must receive NO KPIs.
  // Non-admins otherwise get the `visibility='staff'` rows below; onboarding was
  // never excluded, so — chained with open sign-up — brand-new accounts could
  // read staff-tier business KPIs. Mirror /api/kpis, which early-returns empty
  // for onboarding. Only staff/admin/superadmin proceed; everything else (incl.
  // undefined) is denied data.
  const role = (session.user as Record<string, unknown>)?.role as string | undefined
  if (!role || !['staff', 'admin', 'superadmin'].includes(role)) {
    return NextResponse.json({ rows: [], source: 'db' })
  }

  const TENANT_ID = getTenantId()
  await ensureTenant(TENANT_ID)
  const isAdmin = role === 'admin' || role === 'superadmin'

  // Build the WHERE clause as a single combined condition.
  // NOTE: chaining `.where()` twice on a $dynamic() query REPLACES the
  // first condition — it does not AND them. That previously dropped the
  // tenant filter for non-admins, leaking other tenants' KPIs. Combine
  // both predicates with and() so tenant scoping always holds.
  const whereClause = isAdmin
    ? eq(kpis.tenantId, TENANT_ID)
    : and(eq(kpis.tenantId, TENANT_ID), eq(kpis.visibility, 'staff'))

  const rows = await db
    .select()
    .from(kpis)
    .where(whereClause)
    .orderBy(kpis.updatedAt)
  return NextResponse.json({ rows, source: 'db' })
})

/**
 * POST /api/settings/kpis
 * Creates a new KPI row. Admin only.
 */
export const POST = withFault('settings/kpis', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const role = (session.user as Record<string, unknown>)?.role as string
  if (role !== 'admin' && role !== 'superadmin') {
    return NextResponse.json({ error: 'Forbidden — admin access required' }, { status: 403 })
  }

  const body = await req.json()
  const { label, value, trend, trendDirection, unit, scope, visibility } = body

  if (!label) return NextResponse.json({ error: 'label is required' }, { status: 400 })

  await ensureTenant(getTenantId())
  const TENANT_ID = getTenantId()
  const [row] = await db
    .insert(kpis)
    .values({
      tenantId: TENANT_ID,
      label: String(label),
      value: value != null ? String(value) : '0',
      trend: trend ? String(trend) : null,
      trendDirection: trendDirection || 'neutral',
      unit: unit ? String(unit) : null,
      scope: scope || 'global',
      visibility: visibility || 'staff',
      updatedBy: (session.user as Record<string, unknown>)?.email as string,
    })
    .returning()

  return NextResponse.json({ row, created: true })
})

/**
 * PATCH /api/settings/kpis
 * Updates an existing KPI row by ID. Admin only.
 */
export const PATCH = withFault('settings/kpis', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const role = (session.user as Record<string, unknown>)?.role as string
  if (role !== 'admin' && role !== 'superadmin') {
    return NextResponse.json({ error: 'Forbidden — admin access required' }, { status: 403 })
  }

  const body = await req.json()
  const { id, ...fields } = body
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const updateData: Record<string, unknown> = { updatedAt: new Date(), updatedBy: (session.user as Record<string, unknown>)?.email as string }
  if (fields.label != null)          updateData.label          = String(fields.label)
  if (fields.value != null)          updateData.value          = String(fields.value)
  if (fields.trend != null)          updateData.trend          = String(fields.trend)
  if (fields.trendDirection != null) updateData.trendDirection = String(fields.trendDirection)
  if (fields.unit != null)           updateData.unit           = String(fields.unit)
  if (fields.scope != null)          updateData.scope          = String(fields.scope)
  if (fields.visibility != null)     updateData.visibility     = String(fields.visibility)

  const [row] = await db
    .update(kpis)
    .set(updateData)
    .where(and(eq(kpis.id, id), eq(kpis.tenantId, getTenantId())))
    .returning()

  if (!row) return NextResponse.json({ error: 'KPI not found or access denied' }, { status: 404 })
  return NextResponse.json({ row, updated: true })
})

/**
 * DELETE /api/settings/kpis
 * Deletes a KPI row by ID. Admin only.
 */
export const DELETE = withFault('settings/kpis', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const role = (session.user as Record<string, unknown>)?.role as string
  if (role !== 'admin' && role !== 'superadmin') {
    return NextResponse.json({ error: 'Forbidden — admin access required' }, { status: 403 })
  }

  const { searchParams } = req.nextUrl
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const result = await db
    .delete(kpis)
    .where(and(eq(kpis.id, id), eq(kpis.tenantId, getTenantId())))
    .returning({ id: kpis.id })

  if (!result.length) return NextResponse.json({ error: 'KPI not found or access denied' }, { status: 404 })
  return NextResponse.json({ deleted: true })
})
