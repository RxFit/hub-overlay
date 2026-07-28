/**
 * Per-tenant Google analytics configuration — pure half (no DB import).
 *
 * Which GA4 property and Search Console site a tenant's numbers come from is a
 * TENANT-level fact, not a per-user one: one business has one set of numbers,
 * and two admins looking at the dashboard must see the same figures.
 */

export interface GooglePrefsValues {
  ga4PropertyId?: string
  gscSiteUrl?: string
  bigqueryProjectId?: string
  timezone?: string
}

export const EMPTY_GOOGLE_PREFS: GooglePrefsValues = {}

/**
 * Merge stored per-tenant settings over the legacy env vars.
 *
 * The env vars (`GA4_PROPERTY_ID`, `GSC_SITE_URL`) are what the single-tenant
 * deployment runs on today. Keeping them as a FALLBACK — rather than deleting
 * them with the migration — means the KPI board keeps working the moment this
 * ships and stops working never; an admin picking a property in Settings simply
 * takes precedence from then on.
 */
export function resolvePrefs(stored: GooglePrefsValues | null): GooglePrefsValues {
  return {
    ga4PropertyId: stored?.ga4PropertyId || process.env.GA4_PROPERTY_ID || undefined,
    gscSiteUrl: stored?.gscSiteUrl || process.env.GSC_SITE_URL || undefined,
    bigqueryProjectId: stored?.bigqueryProjectId || undefined,
    timezone: stored?.timezone || undefined,
  }
}

/**
 * Harden admin-supplied values. Never throws — an unusable value is dropped
 * rather than stored, so a typo cannot wedge the analytics config.
 */
export function normalizePrefsInput(input: unknown): GooglePrefsValues {
  const raw = (input ?? {}) as Record<string, unknown>
  const str = (v: unknown, max = 200) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

  const ga4 = str(raw.ga4PropertyId, 40)

  return {
    // GA4 property ids are numeric; callers sometimes paste "properties/123".
    ga4PropertyId: ga4 ? ga4.replace(/^properties\//, '').replace(/\D/g, '') || undefined : undefined,
    gscSiteUrl: str(raw.gscSiteUrl),
    bigqueryProjectId: str(raw.bigqueryProjectId, 100),
    timezone: str(raw.timezone, 64),
  }
}
