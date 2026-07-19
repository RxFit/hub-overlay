/* ══════════════════════════════════════════════════════════════════════════
   SUGGESTION MEMORY — dismissal memory + frequency caps for SolutionCards
   (Phase 6a). Guardrails 1 & 2 from PHASE6_PAPERCLIP_AS_SOLUTION_2026-07-19.md.

   v1 storage is localStorage (per-browser); the pure decision functions take
   state explicitly so they unit-test without a DOM and can move to a DB-backed
   store in v2 without touching callers. SSR-safe: every DOM access is guarded.
   ══════════════════════════════════════════════════════════════════════════ */

export interface SuggestionMemory {
  /** dismissKey → epoch ms when suppression lifts (Infinity = permanent). */
  dismissed: Record<string, number>
  /** epoch ms of each SolutionCard shown, for the rolling frequency cap. */
  shownAt: number[]
}

export const SUGGESTION_CONFIG = {
  /** Max cards shown per rolling 24h. */
  perDay: 3,
  /** Min assistant turns between cards. */
  minTurnGap: 5,
  /** Temporary "Not now" suppression window. */
  snoozeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  /** Only render deterministic suggestions at/above this confidence. */
  minConfidence: 0.6,
} as const

const STORAGE_KEY = 'hub.suggestionMemory.v1'
const DAY_MS = 24 * 60 * 60 * 1000

export function emptyMemory(): SuggestionMemory {
  return { dismissed: {}, shownAt: [] }
}

/* ── Pure decision helpers (no I/O) ── */

/** Is this dismissKey currently suppressed at `now`? */
export function isDismissed(mem: SuggestionMemory, dismissKey: string, now: number): boolean {
  const until = mem.dismissed[dismissKey]
  return until != null && now < until
}

/**
 * May a new card be shown right now, given confidence and the frequency caps?
 * `turnsSinceLast` is assistant turns since the last shown card (Infinity if none).
 */
export function canShow(
  mem: SuggestionMemory,
  confidence: number,
  turnsSinceLast: number,
  now: number,
): boolean {
  if (confidence < SUGGESTION_CONFIG.minConfidence) return false
  if (turnsSinceLast < SUGGESTION_CONFIG.minTurnGap) return false
  const recent = mem.shownAt.filter((t) => now - t < DAY_MS)
  return recent.length < SUGGESTION_CONFIG.perDay
}

/** Record that a card was shown (prunes entries older than 24h). */
export function recordShown(mem: SuggestionMemory, now: number): SuggestionMemory {
  const shownAt = [...mem.shownAt.filter((t) => now - t < DAY_MS), now]
  return { ...mem, shownAt }
}

/** Snooze (temporary) or block (permanent) a dismissKey. */
export function recordDismissed(
  mem: SuggestionMemory,
  dismissKey: string,
  permanent: boolean,
  now: number,
): SuggestionMemory {
  const until = permanent ? Number.POSITIVE_INFINITY : now + SUGGESTION_CONFIG.snoozeMs
  return { ...mem, dismissed: { ...mem.dismissed, [dismissKey]: until } }
}

/* ── localStorage persistence (client only) ── */

export function loadMemory(): SuggestionMemory {
  if (typeof window === 'undefined') return emptyMemory()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyMemory()
    const parsed = JSON.parse(raw)
    // JSON.stringify turns Infinity into null — restore permanents.
    const dismissed: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed?.dismissed ?? {})) {
      dismissed[k] = v === null ? Number.POSITIVE_INFINITY : Number(v)
    }
    return {
      dismissed,
      shownAt: Array.isArray(parsed?.shownAt) ? parsed.shownAt.map(Number) : [],
    }
  } catch {
    return emptyMemory()
  }
}

export function saveMemory(mem: SuggestionMemory): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(mem))
  } catch {
    /* quota / private mode — suggestions just won't persist */
  }
}
