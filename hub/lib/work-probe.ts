/**
 * lib/work-probe.ts — pure helpers for the deep lane's admin work probe
 * (docs/architecture/DEEP_LANE_2026-08-23.md §8, PR A).
 *
 * Split out of app/api/admin/work-probe/route.ts because Next.js route files
 * may export ONLY route handlers — `next build` rejects any other export —
 * and these two functions need direct unit tests.
 */

// worldtimeapi.org intermittently fails TLS/returns an empty body from the
// desktop worker. Postman Echo's current-time endpoint is deliberately simple
// (a short RFC-1123 body) and avoids putting the worker's public IP in the
// probe payload.
export const DEFAULT_PROBE_URL = 'https://postman-echo.com/time/now'

export function buildProbePrompt(url: string, marker: string): string {
  return [
    'You are running as a headless work-item probe for the Hub deep lane.',
    `Use your web tools to fetch this URL and read its response body: ${url}`,
    'Then reply with EXACTLY two lines and nothing else:',
    `Line 1: ${marker}`,
    'Line 2: the datetime (or equivalent timestamp) value from the fetched response, verbatim; if the response is not JSON, the first 120 characters of the body.',
    'If you could not perform a live fetch with a tool, reply instead with:',
    `Line 1: ${marker}`,
    'Line 2: NO_TOOLS: one short sentence naming what stopped you.',
  ].join('\n')
}

/** Any ISO-8601-ish timestamp in the text within ±window of now. A model
 *  without tools has no wall clock, so a fresh timestamp is strong evidence
 *  of a live fetch (and unlike echoed content, it cannot be pre-trained). */
export function containsFreshTimestamp(text: string, now: number, windowMs: number): boolean {
  const iso = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g
  const rfc1123 = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT\b/g
  const candidates = [...(text.match(iso) ?? []), ...(text.match(rfc1123) ?? [])]
  for (const candidate of candidates) {
    // JavaScript Date accepts milliseconds but some time APIs emit six or
    // seven fractional digits. Truncate, never round: the freshness window is
    // minutes wide. A timezone-less ISO value from a UTC time endpoint is
    // interpreted explicitly as UTC instead of inheriting the server locale.
    let parseable = candidate.replace(/(\.\d{3})\d+/, '$1')
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(parseable) && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(parseable)) {
      parseable += 'Z'
    }
    const t = Date.parse(parseable)
    if (Number.isFinite(t) && Math.abs(now - t) <= windowMs) return true
  }
  return false
}
