/**
 * Hub User Roles — Drizzle/Postgres implementation.
 *
 * Replaces the old hubRoles.ts (Google Sheets-based).
 * All reads/writes go directly to the `hub_users` table.
 *
 * Tenant ID is resolved per-call via lib/tenant-context (request header →
 * env var → 'rxfit' fallback). Callers may pass an explicit tenantId.
 */

import { eq, and } from 'drizzle-orm'
import { db } from './db'
import { hubUsers, tenants } from './schema'
import { getTenantId } from './tenant-context'

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
  tenantId = getTenantId(),
  name = 'RxFit Athletics'
): Promise<void> {
  await db
    .insert(tenants)
    .values({ id: tenantId, name })
    .onConflictDoNothing()
}

/* ── Read all role entries for a tenant ─────────────────────────────────── */

export async function getAllRoleEntries(
  tenantId = getTenantId()
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
  tenantId = getTenantId()
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
  tenantId = getTenantId()
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
        updatedAt:        new Date(),
        ...(entry.name ? { name: entry.name } : {}),
      },
    })
}
