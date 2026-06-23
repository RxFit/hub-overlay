/**
 * Parse a query-string integer and clamp it to [min, max], falling back for
 * missing/non-numeric input. Used to bound `maxResults` on the Google routes so
 * a caller can't pass `-1`, `999999`, or `NaN` straight through to the upstream
 * API (audit P2).
 */
export function clampInt(
  value: string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value == null || value === '') return fallback
  const n = parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}
