/**
 * Per-tenant Google analytics configuration — DB access (SERVER-ONLY).
 *
 * Split from prefs.ts (pure, client-safe) so the settings UI can import the
 * types without dragging Postgres into the browser bundle. Mirrors
 * lib/chat-space-preferences-db.ts.
 *
 * Reads FAIL-OPEN to the env-var fallback: an analytics config lookup failing
 * should degrade the KPI board to its previous single-property behavior, not
 * blank it. Writes throw, so the settings PUT can report an honest failure —
 * a silent "saved" that didn't persist is its own bug.
 */

import { eq } from 'drizzle-orm'
import { db } from '../db'
import { googlePrefs, tenants } from '../schema'
import { getTenantId } from '../tenant-context'
import { resolvePrefs, type GooglePrefsValues } from './prefs'

async function ensureTenant(tenantId: string): Promise<void> {
  await db.insert(tenants).values({ id: tenantId, name: tenantId }).onConflictDoNothing()
}

/** Stored prefs for a tenant, or null when none have been saved. */
export async function getStoredPrefs(tenantId = getTenantId()): Promise<GooglePrefsValues | null> {
  const [row] = await db.select().from(googlePrefs).where(eq(googlePrefs.tenantId, tenantId)).limit(1)
  if (!row) return null
  return {
    ga4PropertyId: row.ga4PropertyId ?? undefined,
    gscSiteUrl: row.gscSiteUrl ?? undefined,
    bigqueryProjectId: row.bigqueryProjectId ?? undefined,
    timezone: row.timezone ?? undefined,
  }
}

/**
 * Effective configuration: stored values over env-var fallback. This is what
 * every analytics caller should use.
 */
export async function getEffectivePrefs(tenantId = getTenantId()): Promise<GooglePrefsValues> {
  try {
    return resolvePrefs(await getStoredPrefs(tenantId))
  } catch (err) {
    console.error('[google-prefs] read failed (falling back to env vars):', err)
    return resolvePrefs(null)
  }
}

/** Upsert a tenant's analytics configuration. Throws on failure. */
export async function savePrefs(
  values: GooglePrefsValues,
  updatedBy: string,
  tenantId = getTenantId(),
): Promise<GooglePrefsValues> {
  await ensureTenant(tenantId)
  await db
    .insert(googlePrefs)
    .values({
      tenantId,
      ga4PropertyId: values.ga4PropertyId ?? null,
      gscSiteUrl: values.gscSiteUrl ?? null,
      bigqueryProjectId: values.bigqueryProjectId ?? null,
      timezone: values.timezone ?? null,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: googlePrefs.tenantId,
      set: {
        ga4PropertyId: values.ga4PropertyId ?? null,
        gscSiteUrl: values.gscSiteUrl ?? null,
        bigqueryProjectId: values.bigqueryProjectId ?? null,
        timezone: values.timezone ?? null,
        updatedBy,
        updatedAt: new Date(),
      },
    })
  return values
}
