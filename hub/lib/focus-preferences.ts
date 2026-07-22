/**
 * Focus Preferences — per-user personalization for the Gmail Focus queue.
 *
 * Two ingredients the ranker needs but Gmail can't supply: a VIP list (who
 * matters, each tagged business|personal) and a short free-text "what matters
 * to me now" goals string. This is a UNIFIED list (one matrix, per-item
 * category) rather than separate personal/business lists — a personal
 * necessity (a family member, a clinic) and a business necessity (a key client)
 * both belong to the same "surface this first" set.
 *
 * This module is PURE (no DB import) so it is safe to bundle into client
 * components (the settings editor needs the constants + types). The DB access —
 * getFocusPreferences / upsertFocusPreferences — lives in
 * lib/focus-preferences-db.ts, which is server-only.
 *
 * The pure helpers (normalize / match / signature) are unit-tested and used by
 * both the AI prompt and the deterministic heuristic.
 *
 * TRUST NOTE: VIP values and goals are USER-authored (the account owner writing
 * about their own inbox), so they are trusted guidance in the prompt — unlike
 * sender-controlled subject/snippet, which stay walled inside <email_data>.
 */

export type FocusVipCategory = 'business' | 'personal'

export interface FocusVip {
  /** Email address, domain fragment (e.g. "@acme.com"), or name to match
   *  case-insensitively against a sender's From header. */
  value: string
  category: FocusVipCategory
}

export interface FocusPreferences {
  vips: FocusVip[]
  goals: string
}

export const EMPTY_FOCUS_PREFERENCES: FocusPreferences = { vips: [], goals: '' }

export const MAX_VIPS = 50
export const MAX_VIP_LENGTH = 120
export const MAX_GOALS_LENGTH = 1000
/** Below this length a VIP value is too generic and would over-match every
 *  sender (e.g. "a"), so it's dropped during normalization. */
export const MIN_VIP_LENGTH = 2

const CATEGORIES: ReadonlySet<string> = new Set<FocusVipCategory>(['business', 'personal'])

const stripControl = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim()

/**
 * Harden untrusted PUT input into a valid FocusPreferences. Never throws:
 * drops malformed VIP entries, dedupes case-insensitively (first wins),
 * enforces MIN/MAX lengths and the MAX_VIPS cap, defaults an unknown category
 * to 'business', and clamps goals length.
 */
export function normalizeFocusPreferences(input: unknown): FocusPreferences {
  const obj = (input ?? {}) as Record<string, unknown>

  const goals = typeof obj.goals === 'string'
    ? stripControl(obj.goals).slice(0, MAX_GOALS_LENGTH)
    : ''

  const rawVips = Array.isArray(obj.vips) ? obj.vips : []
  const seen = new Set<string>()
  const vips: FocusVip[] = []
  for (const entry of rawVips) {
    if (vips.length >= MAX_VIPS) break
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const value = typeof e.value === 'string' ? stripControl(e.value).slice(0, MAX_VIP_LENGTH) : ''
    if (value.length < MIN_VIP_LENGTH) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    const category: FocusVipCategory = CATEGORIES.has(e.category as string)
      ? (e.category as FocusVipCategory)
      : 'business'
    seen.add(key)
    vips.push({ value, category })
  }

  return { vips, goals }
}

/**
 * Match a sender's From header against the VIP list — case-insensitive
 * substring, so an email, a domain fragment ("@acme.com"), or a display name
 * all work. Returns the first matching VIP, or null.
 */
export function matchVip(from: string, vips: readonly FocusVip[]): FocusVip | null {
  if (!from || vips.length === 0) return null
  const haystack = from.toLowerCase()
  for (const vip of vips) {
    const needle = vip.value.toLowerCase()
    if (needle.length >= MIN_VIP_LENGTH && haystack.includes(needle)) return vip
  }
  return null
}

/**
 * Stable fingerprint of the preferences, folded into the Focus cache key so
 * editing VIPs/goals invalidates a cached ranking instead of serving a stale
 * one for the full TTL. Order-independent for VIPs (sorted) so reordering the
 * list alone doesn't force a re-rank.
 */
export function focusPreferencesSignature(prefs: FocusPreferences): string {
  if (prefs.vips.length === 0 && !prefs.goals) return 'p0'
  const vipPart = prefs.vips
    .map(v => `${v.category}:${v.value.toLowerCase()}`)
    .sort()
    .join(',')
  // Goals folded in by length + a cheap rolling hash — enough to detect edits
  // without hashing the whole (bounded) string cryptographically.
  let h = 0
  for (let i = 0; i < prefs.goals.length; i++) {
    h = (h * 31 + prefs.goals.charCodeAt(i)) | 0
  }
  return `v:${vipPart}|g:${prefs.goals.length}:${h}`
}
