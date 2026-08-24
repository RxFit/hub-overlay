/**
 * lib/work-probe.ts — pure helpers for the deep lane's admin work probe
 * (docs/architecture/DEEP_LANE_2026-08-23.md §8, PR A).
 *
 * Split out of app/api/admin/work-probe/route.ts because Next.js route files
 * may export ONLY route handlers — `next build` rejects any other export —
 * and these two functions need direct unit tests.
 */

export const DEFAULT_PROBE_URL = 'https://worldtimeapi.org/api/ip'

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
  for (const match of text.match(iso) ?? []) {
    const t = Date.parse(match)
    if (Number.isFinite(t) && Math.abs(now - t) <= windowMs) return true
  }
  return false
}
