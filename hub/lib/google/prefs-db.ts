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
import { normalizeReports } from '../reports/config'

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
    reports: normalizeReports(row.reports),
  }
}

export interface EffectivePrefsOutcome {
  prefs: GooglePrefsValues
  /** True when the STORED-prefs read threw (DB failure). The env-fallback
   *  values in `prefs` still keep tools working, but a caller describing the
   *  tenant's configuration (the capability manifest) must not present a
   *  failed read as "nothing is configured" — that is how a DB blip made the
   *  assistant tell an admin their just-configured GA4 property didn't exist. */
  storeReadFailed: boolean
}

/**
 * Effective configuration WITH read-failure visibility: stored values over
 * env-var fallback, plus whether the store read actually succeeded.
 */
export async function getEffectivePrefsDetailed(tenantId = getTenantId()): Promise<EffectivePrefsOutcome> {
  try {
    return { prefs: resolvePrefs(await getStoredPrefs(tenantId)), storeReadFailed: false }
  } catch (err) {
    console.error('[google-prefs] read failed (falling back to env vars):', err)
    return { prefs: resolvePrefs(null), storeReadFailed: true }
  }
}

/**
 * Effective configuration: stored values over env-var fallback. This is what
 * every analytics caller should use.
 */
export async function getEffectivePrefs(tenantId = getTenantId()): Promise<GooglePrefsValues> {
  return (await getEffectivePrefsDetailed(tenantId)).prefs
}

/**
 * Upsert a tenant's analytics configuration. Throws on failure.
 *
 * PARTIAL by key presence: only fields present on `values` are written, so a
 * caller that edits analytics sources cannot blank the report schedule and a
 * caller that edits the schedule cannot blank the analytics sources. The
 * previous version wrote every column as `value ?? null` on every save, which
 * made each partial UI post silently clear the fields it didn't mention.
 * `normalizePrefsInput` is what decides presence.
 */
export async function savePrefs(
  values: GooglePrefsValues,
  updatedBy: string,
  tenantId = getTenantId(),
): Promise<GooglePrefsValues> {
  await ensureTenant(tenantId)

  // Build the column set from present keys only. `undefined` on a present key
  // is a deliberate clear (the admin emptied the field) and maps to null.
  const columns: Record<string, unknown> = {}
  if ('ga4PropertyId' in values) columns.ga4PropertyId = values.ga4PropertyId ?? null
  if ('gscSiteUrl' in values) columns.gscSiteUrl = values.gscSiteUrl ?? null
  if ('bigqueryProjectId' in values) columns.bigqueryProjectId = values.bigqueryProjectId ?? null
  if ('timezone' in values) columns.timezone = values.timezone ?? null
  if ('reports' in values) columns.reports = normalizeReports(values.reports)

  await db
    .insert(googlePrefs)
    .values({ tenantId, updatedBy, ...columns })
    .onConflictDoUpdate({
      target: googlePrefs.tenantId,
      set: { ...columns, updatedBy, updatedAt: new Date() },
    })

  return values
}
