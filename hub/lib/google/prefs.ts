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
  /** Scheduled report configs. Typed loosely here so this module stays free of
   *  the reports import; normalized via normalizeReports on the way in/out. */
  reports?: unknown[]
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
    reports: stored?.reports ?? [],
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

  // Only include keys the caller actually SENT.
  //
  // Returning every key with `undefined` for the absent ones made the writer
  // null them out: the settings UI posts just ga4PropertyId + gscSiteUrl, which
  // wiped any stored timezone. The dangerous direction is the mirror image —
  // once a reports editor posts only `reports`, the same shape would wipe the
  // tenant's analytics sources. Presence, not value, decides what gets written.
  const out: GooglePrefsValues = {}

  if ('ga4PropertyId' in raw) {
    // GA4 property ids are numeric; callers sometimes paste "properties/123".
    out.ga4PropertyId = ga4 ? ga4.replace(/^properties\//, '').replace(/\D/g, '') || undefined : undefined
  }
  if ('gscSiteUrl' in raw) out.gscSiteUrl = str(raw.gscSiteUrl)
  if ('bigqueryProjectId' in raw) out.bigqueryProjectId = str(raw.bigqueryProjectId, 100)
  if ('timezone' in raw) out.timezone = str(raw.timezone, 64)
  if ('reports' in raw) out.reports = Array.isArray(raw.reports) ? raw.reports : []

  return out
}
