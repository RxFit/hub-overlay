import { timingSafeEqual } from 'crypto'

/**
 * Service credentials for the vault routes — constant-time, fail closed.
 *
 * Mirrors app/api/embeddings/upsert/route.ts: a plain `===` on a bearer leaks
 * key material through response timing, so every compare goes through a
 * length guard + timingSafeEqual, and an UNSET secret never matches anything.
 *
 * Two credentials, two shapes:
 *  - VAULT_SYNC_API_KEY — one opaque key for the ingestion route. Whoever
 *    holds it can trigger a sync (a read of the vault into the index); it can
 *    never write to the vault.
 *  - VAULT_SEARCH_KEYS — a JSON object mapping each search key to the harness
 *    that holds it and the tenant it is bound to:
 *      {"<key>": {"harness": "instinct", "tenantId": "rxfit"}, …}
 *    The binding is what makes a cross-tenant request a 403 rather than a
 *    body field the caller controls. Keys shorter than MIN_KEY_LENGTH are
 *    refused at parse time (a weak bearer is not a credential).
 *
 * Nothing in this module logs a key, a header, or the parsed map.
 */

export const MIN_KEY_LENGTH = 16
const HARNESS = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TENANT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export interface SearchKeyBinding {
  harness: string
  tenantId: string
}

export interface SearchPrincipal extends SearchKeyBinding {
  via: 'bearer' | 'session'
}

/** Constant-time string equality (false on any length mismatch). */
export function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  if (x.length !== y.length) return false
  try {
    return timingSafeEqual(x, y)
  } catch {
    return false
  }
}

/** `Authorization: Bearer <token>` → token, else null. Scheme is case-insensitive. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header)
  return m ? m[1] : null
}

/** True only when VAULT_SYNC_API_KEY is set AND the header carries exactly it. */
export function verifySyncBearer(header: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const expected = env.VAULT_SYNC_API_KEY?.trim()
  if (!expected || expected.length < MIN_KEY_LENGTH) return false
  const token = bearerToken(header)
  if (!token) return false
  return constantTimeEquals(token, expected)
}

export interface ParsedSearchKeys {
  bindings: Map<string, SearchKeyBinding>
  /** Entries dropped for being malformed/weak — counts only, never the keys. */
  rejected: number
  /** Set when the env var was present but not a JSON object at all. */
  malformed: boolean
}

let cached: { raw: string; parsed: ParsedSearchKeys } | null = null

/**
 * Parse VAULT_SEARCH_KEYS. Memoized on the raw string so the JSON is parsed
 * once per process (and a malformed value is not re-reported per request).
 */
export function parseSearchKeys(raw: string | undefined): ParsedSearchKeys {
  const text = (raw ?? '').trim()
  if (cached && cached.raw === text) return cached.parsed
  const parsed = parseSearchKeysUncached(text)
  cached = { raw: text, parsed }
  return parsed
}

function parseSearchKeysUncached(text: string): ParsedSearchKeys {
  const bindings = new Map<string, SearchKeyBinding>()
  if (!text) return { bindings, rejected: 0, malformed: false }
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return { bindings, rejected: 0, malformed: true }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { bindings, rejected: 0, malformed: true }
  let rejected = 0
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const v = value as { harness?: unknown; tenantId?: unknown } | null
    const harness = typeof v?.harness === 'string' ? v.harness.trim() : ''
    const tenantId = typeof v?.tenantId === 'string' ? v.tenantId.trim() : ''
    if (key.length < MIN_KEY_LENGTH || !HARNESS.test(harness) || !TENANT.test(tenantId)) {
      rejected++
      continue
    }
    bindings.set(key, { harness, tenantId })
  }
  return { bindings, rejected, malformed: false }
}

/**
 * Resolve a bearer header to its bound principal, or null. Every configured
 * key is compared (no early exit on match) so the compare count does not
 * depend on which key was presented; each compare is constant-time.
 */
export function authenticateSearchBearer(
  header: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): SearchPrincipal | null {
  const token = bearerToken(header)
  if (!token) return null
  const { bindings } = parseSearchKeys(env.VAULT_SEARCH_KEYS)
  if (bindings.size === 0) return null
  let matched: SearchKeyBinding | null = null
  for (const [key, binding] of bindings) {
    if (constantTimeEquals(token, key)) matched = binding
  }
  return matched ? { ...matched, via: 'bearer' } : null
}

/** Presence/count only — for the health route and the runbook's "is it wired" check. */
export function describeSearchKeys(env: Record<string, string | undefined> = process.env): { configured: boolean; count: number; rejected: number; malformed: boolean } {
  const parsed = parseSearchKeys(env.VAULT_SEARCH_KEYS)
  return { configured: parsed.bindings.size > 0, count: parsed.bindings.size, rejected: parsed.rejected, malformed: parsed.malformed }
}

export function isSyncKeyConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.VAULT_SYNC_API_KEY?.trim()
  return Boolean(v && v.length >= MIN_KEY_LENGTH)
}

/** Test hook: drop the memoized parse. */
export function _resetSearchKeyCacheForTests(): void {
  cached = null
}
