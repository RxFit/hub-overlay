/**
 * Server-side fingerprint rule table — the escape hatch for OVER-SPLITTING
 * (ERROR_REPORTING_2026-08-24.md §5).
 *
 * The cascade in lib/fault-fingerprint.ts sometimes fragments one real bug
 * across many fingerprints (an unstable frame, an unnormalized message
 * token). When that happens, add a rule here mapping `code` + a route glob to
 * one explicit key — editable WHILE the noisy fault is firing, no algorithm
 * change needed. The rule's key feeds the cascade's `explicit` rung, so two
 * occurrences matching the same rule always share a group.
 *
 * This table shipping in Phase 1 is deliberate: if it slipped, "one hour a
 * month of tuning" silently becomes "nobody tunes it", and by month eighteen
 * the fingerprint space has fragmented far enough that new-fault alerting
 * means nothing.
 *
 * Rule format: `routeGlob` supports `*` (any run of characters). First match
 * wins — keep the table short and most-specific-first.
 */

export interface FingerprintRule {
  code: string
  routeGlob: string
  /** Becomes the `explicit` key — a short stable slug, e.g. 'gmail-timeouts'. */
  key: string
}

/** The live table. Empty at launch — rules are added as noise is observed. */
export const FINGERPRINT_RULES: readonly FingerprintRule[] = []

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/** First matching rule's key, or null. Pure; the table is injectable for tests. */
export function matchFingerprintRule(
  code: string,
  route: string | null | undefined,
  rules: readonly FingerprintRule[] = FINGERPRINT_RULES,
): string | null {
  for (const rule of rules) {
    if (rule.code !== code) continue
    if (globToRegExp(rule.routeGlob).test(route ?? '')) return rule.key
  }
  return null
}
