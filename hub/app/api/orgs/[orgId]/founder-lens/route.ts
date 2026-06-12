import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { founderLensSections, tenants } from '@/lib/schema'
import type { FounderLensConfig, FounderLensCustomSection } from '@/types'
import { getDefaultTenantId } from '@/lib/tenant-context'

export const runtime = 'nodejs'

/* ══════════════════════════════════════════════════════════════════════════════
   FOUNDER LENS API  (DB-backed — replaces the old filesystem FOUNDER_LENS.md
   files under ../orchestration, which do not exist in the deployed container)

   GET  /api/orgs/[orgId]/founder-lens  → read current CUSTOM sections per role
   POST /api/orgs/[orgId]/founder-lens  → upsert CUSTOM sections per role
   ══════════════════════════════════════════════════════════════════════════════ */

// Phase 1 (multi-tenancy): resolve per-request from hostname instead of env.
const TENANT_ID = getDefaultTenantId()

// Valid role keys accepted by the wizard.
const VALID_ROLES = new Set([
  'ceo', 'cmo', 'cto', 'cfo', 'coo', 'marketing', 'technical', 'revenue',
])

/** Idempotently ensure the tenant row exists (FK target). */
async function ensureTenant() {
  await db
    .insert(tenants)
    .values({ id: TENANT_ID, name: 'RxFit Athletics', domain: 'rxfitatx.com' })
    .onConflictDoNothing()
}

/** Render a structured section into the markdown block the client expects. */
function buildCustomSection(section: FounderLensCustomSection): string {
  const lines: string[] = []
  if (section.okrs) lines.push(`**OKRs:**\n${section.okrs}`)
  if (section.competitiveAdvantages) lines.push(`**Competitive Advantages:**\n${section.competitiveAdvantages}`)
  if (section.idealCustomer) lines.push(`**Ideal Customer:**\n${section.idealCustomer}`)
  if (section.quarterlyGoals) lines.push(`**Quarterly Goals:**\n${section.quarterlyGoals}`)
  if (section.annualGoals) lines.push(`**Annual Goals:**\n${section.annualGoals}`)
  if (section.tonePreferences) lines.push(`**Tone & Voice:**\n${section.tonePreferences}`)
  if (section.uniqueInstructions) lines.push(`**Operating Instructions:**\n${section.uniqueInstructions}`)
  return lines.join('\n\n')
}

export async function GET(
  req: Request,
  { params }: { params: { orgId: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const orgId = params.orgId

  // Security Check: Ensure user has access to this org
  const userRole = (session.user as Record<string, unknown>).role as string
  const assignedProjects = ((session.user as Record<string, unknown>).assignedProjects as string[]) || []

  const hasAccess =
    userRole === 'superadmin' ||
    assignedProjects.includes('*') ||
    assignedProjects.includes(orgId)

  if (!hasAccess) {
    return NextResponse.json({ error: 'Insufficient permissions for this organization' }, { status: 403 })
  }

  try {
    await ensureTenant()
    const rows = await db
      .select()
      .from(founderLensSections)
      .where(and(eq(founderLensSections.tenantId, TENANT_ID), eq(founderLensSections.orgId, orgId)))

    const result: Record<string, string> = {}
    for (const row of rows) {
      const rendered = buildCustomSection(row.sections as FounderLensCustomSection)
      if (rendered) result[row.role] = rendered
    }

    return NextResponse.json({ orgId, roles: result })
  } catch (err) {
    console.error('[founder-lens GET]', err)
    return NextResponse.json({ error: 'Failed to load Founder Lens config' }, { status: 500 })
  }
}

export async function POST(
  req: Request,
  { params }: { params: { orgId: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Only admins and superadmins can customize the C-Suite.
  const userRole = (session.user as Record<string, unknown>).role as string
  if (!['admin', 'superadmin'].includes(userRole)) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
  }

  const orgId = params.orgId

  // Security Check: Ensure user has access to this org
  const assignedProjects = ((session.user as Record<string, unknown>).assignedProjects as string[]) || []
  const hasAccess =
    userRole === 'superadmin' ||
    assignedProjects.includes('*') ||
    assignedProjects.includes(orgId)

  if (!hasAccess) {
    return NextResponse.json({ error: 'Insufficient permissions for this organization' }, { status: 403 })
  }

  let body: FounderLensConfig
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!Array.isArray(body.roles)) {
    return NextResponse.json({ error: 'roles array is required' }, { status: 400 })
  }

  const updatedBy = (session.user.email as string) ?? 'unknown'
  const errors: string[] = []
  const rolesUpdated: string[] = []

  try {
    await ensureTenant()

    for (const section of body.roles) {
      const role = section.role
      if (!role || !VALID_ROLES.has(role)) {
        errors.push(`${role}: unknown role`)
        continue
      }

      try {
        await db
          .insert(founderLensSections)
          .values({
            tenantId: TENANT_ID,
            orgId,
            role,
            sections: section as unknown as Record<string, unknown>,
            updatedBy,
          })
          .onConflictDoUpdate({
            target: [founderLensSections.tenantId, founderLensSections.orgId, founderLensSections.role],
            set: {
              sections: section as unknown as Record<string, unknown>,
              updatedBy,
              updatedAt: new Date(),
            },
          })
        rolesUpdated.push(role)
      } catch (err) {
        errors.push(`${role}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to save Founder Lens config: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }

  if (errors.length > 0 && rolesUpdated.length === 0) {
    return NextResponse.json({ error: 'All roles failed to update', details: errors }, { status: 500 })
  }
  if (errors.length > 0) {
    return NextResponse.json({ error: 'Some roles failed to update', details: errors }, { status: 207 })
  }

  return NextResponse.json({
    success: true,
    orgId,
    rolesUpdated,
    updatedAt: new Date().toISOString(),
  })
}
