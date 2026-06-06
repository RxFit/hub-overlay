/**
 * Hub User Roles — Drizzle/Postgres implementation.
 *
 * Replaces the old hubRoles.ts (Google Sheets-based).
 * All reads/writes go directly to the `hub_users` table.
 *
 * Tenant ID is resolved from:
 *   1. process.env.NEXT_PUBLIC_TENANT_ID  (Railway env var, currently 'rxfit')
 *   2. Falls back to 'rxfit' if not set
 */

import { eq, and } from 'drizzle-orm'
import { db } from './db'
import { hubUsers, tenants } from './schema'

const DEFAULT_TENANT = process.env.NEXT_PUBLIC_TENANT_ID || 'rxfit'

export interface HubRoleEntry {
  email: string
  role: string
  assignedProjects: string[]
  assignedAt: string
  assignedBy: string
  name?: string
}

/* ── Ensure tenant row exists (idempotent) ──────────────────────────────── */

export async function ensureTenant(
  tenantId = DEFAULT_TENANT,
  name = 'RxFit Athletics'
): Promise<void> {
  await db
    .insert(tenants)
    .values({ id: tenantId, name })
    .onConflictDoNothing()
}

/* ── Read all role entries for a tenant ─────────────────────────────────── */

export async function getAllRoleEntries(
  tenantId = DEFAULT_TENANT
): Promise<HubRoleEntry[]> {
  try {
    await ensureTenant(tenantId)
    const rows = await db
      .select()
      .from(hubUsers)
      .where(eq(hubUsers.tenantId, tenantId))

    return rows.map(r => ({
      email: r.email,
      role: r.role,
      assignedProjects: r.assignedProjects ?? [],
      assignedAt: r.assignedAt?.toISOString() ?? '',
      assignedBy: r.assignedBy ?? '',
      name: r.name ?? undefined,
    }))
  } catch (err) {
    console.error('[userRoles] getAllRoleEntries failed:', err)
    return []
  }
}

/* ── Look up a single user's role ───────────────────────────────────────── */

export async function getUserRole(
  email: string,
  tenantId = DEFAULT_TENANT
): Promise<{ role: string; assignedProjects: string[] }> {
  const normalized = email.toLowerCase().trim()
  try {
    await ensureTenant(tenantId)
    const [row] = await db
      .select()
      .from(hubUsers)
      .where(and(eq(hubUsers.tenantId, tenantId), eq(hubUsers.email, normalized)))
      .limit(1)

    if (!row) return { role: 'onboarding', assignedProjects: [] }
    return { role: row.role, assignedProjects: row.assignedProjects ?? [] }
  } catch (err) {
    console.error('[userRoles] getUserRole failed:', err)
    return { role: 'onboarding', assignedProjects: [] }
  }
}

/* ── Upsert a user role ─────────────────────────────────────────────────── */

export async function upsertUserRole(
  entry: {
    email: string
    role: string
    assignedProjects: string[]
    assignedBy: string
    name?: string
  },
  tenantId = DEFAULT_TENANT
): Promise<void> {
  const normalized = entry.email.toLowerCase().trim()
  await ensureTenant(tenantId)
  await db
    .insert(hubUsers)
    .values({
      tenantId,
      email:            normalized,
      name:             entry.name,
      role:             entry.role,
      assignedProjects: entry.assignedProjects,
      assignedBy:       entry.assignedBy,
    })
    .onConflictDoUpdate({
      target:  [hubUsers.tenantId, hubUsers.email],
      set: {
        role:             entry.role,
        assignedProjects: entry.assignedProjects,
        assignedBy:       entry.assignedBy,
        assignedAt:       new Date(),
        ...(entry.name ? { name: entry.name } : {}),
      },
    })
}
