/**
 * Canonicalize a Google Tasks `due` value before it ever reaches Google.
 *
 * Both write paths — the chat "add/reschedule a task" flow
 * (lib/actions/executeAction.ts) and a direct call to /api/google/tasks —
 * previously forwarded whatever string an LLM extracted from a user's
 * sentence straight through: a bare "2026-07-28" reached Google with no
 * time/zone at all, and free text like "next Friday" or "tomorrow" was fed
 * through as a literal, uninterpreted due date. This is the single function
 * both paths run input through, so a client hitting the route directly can't
 * bypass the safety the chat flow applies.
 *
 * Accepts exactly two shapes:
 *  - A bare calendar date "YYYY-MM-DD" → RFC3339 UTC midnight of THAT SAME
 *    calendar date, built from the string's own digits rather than a `Date`
 *    constructed in the server's local zone — that would roll the day back
 *    for a negative-offset deployment.
 *  - An already-resolved RFC3339 timestamp carrying an explicit zone (Z or
 *    ±HH:MM) → UTC midnight of its WRITTEN calendar date. Google Tasks stores
 *    due dates as date-only values and discards the time component.
 * Anything else — natural language ("next Friday", "tomorrow"), a naive
 * datetime with no zone, or malformed input — is rejected. Resolving natural
 * language into a real date is a UI/interview concern; this function's job is
 * only to refuse to guess.
 */

export type TaskDueCanonicalizeResult =
  | { ok: true; value: string }
  | { ok: false; error: string }

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const ZONED_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function isValidCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const check = new Date(Date.UTC(y, m - 1, d))
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d
}

export function canonicalizeTaskDueDate(input: string): TaskDueCanonicalizeResult {
  const trimmed = (input ?? '').trim()
  if (!trimmed) return { ok: false, error: 'no due date was given' }

  const dateOnly = trimmed.match(DATE_ONLY)
  if (dateOnly) {
    const y = Number(dateOnly[1])
    const m = Number(dateOnly[2])
    const d = Number(dateOnly[3])
    if (!isValidCalendarDate(y, m, d)) {
      return { ok: false, error: `"${trimmed}" is not a valid calendar date` }
    }
    return { ok: true, value: `${trimmed}T00:00:00.000Z` }
  }

  const zoned = trimmed.match(ZONED_DATETIME)
  if (zoned) {
    const y = Number(zoned[1])
    const m = Number(zoned[2])
    const d = Number(zoned[3])
    const h = Number(zoned[4])
    const mi = Number(zoned[5])
    const s = Number(zoned[6])
    const offset = zoned[7]
    const offsetMatch = offset === 'Z' ? null : offset.match(/^[+-](\d{2}):(\d{2})$/)
    const offsetValid = offset === 'Z' || (!!offsetMatch && Number(offsetMatch[1]) <= 23 && Number(offsetMatch[2]) <= 59)

    if (!isValidCalendarDate(y, m, d) || h > 23 || mi > 59 || s > 59 || !offsetValid) {
      return { ok: false, error: `"${trimmed}" is not a valid date-time` }
    }
    return { ok: true, value: `${zoned[1]}-${zoned[2]}-${zoned[3]}T00:00:00.000Z` }
  }

  return {
    ok: false,
    error:
      `"${trimmed}" is not a recognized due date — use an exact calendar date (YYYY-MM-DD) or a ` +
      'resolved timestamp; ambiguous phrases like "next Friday" or "tomorrow" are rejected instead ' +
      'of guessed.',
  }
}
