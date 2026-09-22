import { swallow } from '@/lib/swallow'
import type { ScopeMatcher } from './config'
import { VaultUnavailableError, type VaultFailureReason } from './errors'
import type { VaultSearchHit, VaultSearchResponse } from './search'
import {
  createSmartConnectionsClientFromEnv,
  readSmartConnectionsConfig,
  type LiveVaultHit,
  type SmartConnectionsClient,
  type SmartConnectionsClientOptions,
} from './smart-connections'

/**
 * Lane 2 orchestration — the live desktop lane as ADVISORY EVIDENCE beside the
 * canonical Git-snapshot search. Used by the search route when a request opts
 * in with `includeLive: true`.
 *
 * Precedence is absolute and enforced structurally, not by convention:
 *   - The canonical `hits` array is produced by lib/vault/search.ts from the
 *     git-snapshot corpus ONLY. Nothing in this module receives a mutable
 *     reference to it: crossReferenceLive() reads canonical hits and returns
 *     warning strings. Live hits are never merged, re-ranked, de-duplicated
 *     against or substituted for canonical hits.
 *   - Live hits live in their own `liveEvidence.hits` list, each tagged
 *     `source: 'smart_connections_live'`, `live: true`, with null provenance
 *     for everything the live tool cannot vouch for.
 *   - A live hit on a path the canonical results also contain adds the warning
 *     `live_confirms:<path>`; when its text clearly differs from the indexed
 *     chunk(s) for that path (heuristic below) it also adds
 *     `possible_conflict:<path> — … the canonical snapshot remains
 *     authoritative until the next sync`. A consumer acts on the snapshot and
 *     treats the live text as a reason to verify, never as the answer.
 *
 * The lane can never fail the request: runLiveLane() RESOLVES for every
 * outcome — `ok` / `unavailable` / `disabled` / `timeout` — and the route
 * attaches the block plus one warning. It is bounded twice: by the client's
 * own timeout (SMART_CONNECTIONS_TIMEOUT_MS) and by the request's
 * `maxLatencyMs` deadline, whichever is nearer; when the deadline wins the
 * live call is abandoned (its signal aborted) and reported as `timeout`.
 *
 * Scope: live hits pass through the SAME include/exclude scope as the
 * canonical corpus (lib/vault/config.ts) and the request's `pathPrefix`. The
 * desktop vault contains everything; the lane may only surface what the owner
 * scoped in. Anything else is dropped and counted, never returned.
 *
 * Tenant: the desktop vault belongs to the Hub's own tenant. A credential
 * bound to any other tenant gets `disabled` — the live lane cannot be used to
 * read across a tenant boundary (resolveLiveLane()).
 *
 * The "clearly differs" heuristic (clearlyDiffers()): both texts normalized
 * (lower-case, whitespace collapsed); no conflict when one contains the other;
 * otherwise a conflict when the live excerpt has at least MIN_TOKENS word
 * tokens and fewer than SHARED_FRACTION of them occur anywhere in the
 * canonical chunks for that path. It is deliberately conservative toward
 * flagging: a live block from a different section of the same note can trip
 * it, which is why the warning says "possible" and points at the snapshot.
 */

export type LiveEvidenceStatus = 'ok' | 'unavailable' | 'disabled' | 'timeout'

export interface LiveEvidence {
  status: LiveEvidenceStatus
  latencyMs: number
  hits: LiveVaultHit[]
  /** Failure class when status is not `ok` (Lane 1 reason vocabulary), else null. */
  reason: VaultFailureReason | null
  /** Bounded, redacted operator detail; never note text, never a credential. */
  detail: string | null
  /** Live results not returned: outside the canonical scope, outside pathPrefix, beyond topK, or unmappable to a vault path. */
  dropped: number
}

export type VaultSearchResponseWithLive = VaultSearchResponse & { liveEvidence?: LiveEvidence }

export interface LiveLaneRequest {
  query: string
  topK: number
  pathPrefix?: string
  /** Epoch ms by which the whole request must answer (the route's maxLatencyMs deadline). */
  deadlineAt: number
}

export interface LiveLaneDeps {
  /** null = the lane is disabled for this request; `disabledDetail` says why. */
  client: SmartConnectionsClient | null
  disabledDetail?: string
  scope: ScopeMatcher
  now?: () => number
}

export interface ResolveLiveLaneInput {
  env?: Record<string, string | undefined>
  principalTenantId: string
  serverTenantId: string
  clientOptions?: Partial<SmartConnectionsClientOptions>
}

export const TENANT_MISMATCH_DETAIL = "the live lane is bound to the Hub's own tenant; this credential is bound to another tenant"

/**
 * Decide whether the lane runs for this request: configured (fail closed) AND
 * the principal's tenant is the Hub's own. Never throws; never logs a value.
 */
export function resolveLiveLane(input: ResolveLiveLaneInput): Pick<LiveLaneDeps, 'client' | 'disabledDetail'> {
  const env = input.env ?? process.env
  const cfg = readSmartConnectionsConfig(env)
  if (!cfg.configured) return { client: null, disabledDetail: cfg.detail ?? 'Smart Connections lane is not configured' }
  if (input.principalTenantId !== input.serverTenantId) return { client: null, disabledDetail: TENANT_MISMATCH_DETAIL }
  return { client: createSmartConnectionsClientFromEnv(env, input.clientOptions) }
}

const MAX_TOP_K = 20

/** Same scope as the canonical corpus, then pathPrefix, then topK. Dropped items are counted, never returned. */
export function filterLiveHits(hits: LiveVaultHit[], scope: ScopeMatcher, pathPrefix: string | undefined, topK: number): { hits: LiveVaultHit[]; dropped: number } {
  const kept: LiveVaultHit[] = []
  let dropped = 0
  for (const hit of hits) {
    if (!scope.matches(hit.vaultPath)) {
      dropped++
      continue
    }
    if (pathPrefix && !hit.vaultPath.startsWith(pathPrefix)) {
      dropped++
      continue
    }
    kept.push(hit)
  }
  const limit = Math.min(MAX_TOP_K, Math.max(1, Math.floor(topK)))
  if (kept.length > limit) dropped += kept.length - limit
  return { hits: kept.slice(0, limit), dropped }
}

function bounded(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/**
 * Run the live lane for one request. ALWAYS resolves. The call is raced
 * against min(client timeout, request deadline); losing the race aborts the
 * call and reports `timeout` with the canonical result untouched.
 */
export async function runLiveLane(req: LiveLaneRequest, deps: LiveLaneDeps): Promise<LiveEvidence> {
  const now = deps.now ?? (() => Date.now())
  const t0 = now()
  const empty = { hits: [] as LiveVaultHit[], dropped: 0 }

  if (!deps.client) {
    return { status: 'disabled', latencyMs: 0, ...empty, reason: 'unconfigured', detail: deps.disabledDetail ?? 'Smart Connections lane is not configured' }
  }
  const remaining = req.deadlineAt - t0
  if (remaining <= 0) {
    return { status: 'timeout', latencyMs: 0, ...empty, reason: 'timeout', detail: 'request maxLatencyMs deadline already expired before the live call started' }
  }
  const client = deps.client
  const budgetMs = Math.min(client.timeoutMs, remaining)
  const boundBy = remaining < client.timeoutMs ? `request maxLatencyMs deadline (${remaining}ms remaining)` : `live timeout (${client.timeoutMs}ms)`

  const controller = new AbortController()
  const work = client.search(req.query, { limit: req.topK, signal: controller.signal })
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, budgetMs)
  })

  try {
    const raced = await Promise.race([work.then((value) => ({ value })), deadline])
    if (raced === 'timeout') {
      void work.catch((err: unknown) => swallow(err, { module: 'vault-live-evidence', op: 'search:afterDeadline', severity: 'expected' }))
      return { status: 'timeout', latencyMs: now() - t0, ...empty, reason: 'timeout', detail: `live call abandoned: ${boundBy} expired` }
    }
    const filtered = filterLiveHits(raced.value.hits, deps.scope, req.pathPrefix, req.topK)
    return { status: 'ok', latencyMs: now() - t0, hits: filtered.hits, reason: null, detail: null, dropped: filtered.dropped + raced.value.unmapped }
  } catch (err) {
    const latencyMs = now() - t0
    if (err instanceof VaultUnavailableError) {
      // The client's own timer and the lane's are set to the same budget, so a
      // `timeout` rejection and losing the race above are the same outcome —
      // report it identically, whichever fired first.
      if (err.reason === 'timeout') return { status: 'timeout', latencyMs, ...empty, reason: 'timeout', detail: `live call abandoned: ${boundBy} expired` }
      const status: LiveEvidenceStatus = err.reason === 'unconfigured' ? 'disabled' : 'unavailable'
      return { status, latencyMs, ...empty, reason: err.reason, detail: bounded(err.message) }
    }
    return { status: 'unavailable', latencyMs, ...empty, reason: 'internal', detail: bounded(`live search failed: ${err instanceof Error ? err.message : String(err)}`) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The one warning the route adds for a non-`ok` lane outcome. */
export function liveLaneWarning(evidence: LiveEvidence): string | null {
  const tail = 'canonical snapshot hits are unaffected'
  switch (evidence.status) {
    case 'ok':
      return null
    case 'disabled':
      return `live evidence disabled: ${evidence.detail ?? 'not configured'}; ${tail}`
    case 'timeout':
      return `live evidence timed out: ${evidence.detail ?? 'deadline expired'}; ${tail}`
    case 'unavailable':
      return `live evidence unavailable (${evidence.reason ?? 'unknown'}): ${evidence.detail ?? 'no detail'}; ${tail}`
  }
}

/* ── Cross-reference: warnings only, canonical hits are read, never written ── */

const MIN_TOKENS = 6
const SHARED_FRACTION = 0.5

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

function tokens(s: string): string[] {
  return s.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3)
}

/**
 * True when the live excerpt clearly is not the text the snapshot indexed for
 * that path. Empty text on either side is "cannot judge" (false).
 */
export function clearlyDiffers(liveExcerpt: string, canonicalExcerpts: string[]): boolean {
  const live = normalizeText(liveExcerpt)
  if (!live) return false
  const canon = canonicalExcerpts.map(normalizeText).filter(Boolean)
  if (canon.length === 0) return false
  if (canon.some((c) => c.includes(live) || live.includes(c))) return false
  const liveTokens = new Set(tokens(live))
  if (liveTokens.size < MIN_TOKENS) return false
  const canonTokens = new Set(canon.flatMap(tokens))
  let shared = 0
  for (const t of liveTokens) if (canonTokens.has(t)) shared++
  return shared / liveTokens.size < SHARED_FRACTION
}

export function possibleConflictWarning(path: string): string {
  return `possible_conflict:${path} — live desktop content differs from the indexed snapshot; the canonical snapshot remains authoritative until the next sync`
}

/**
 * Warnings for paths present in BOTH lists, in canonical order, one per path:
 * `live_confirms:<path>` always, plus possible_conflict when any live hit for
 * the path clearly differs from the canonical chunk(s). Pure: no input is
 * mutated, nothing is merged.
 */
export function crossReferenceLive(canonical: readonly VaultSearchHit[], live: readonly LiveVaultHit[]): string[] {
  if (canonical.length === 0 || live.length === 0) return []
  const liveByPath = new Map<string, LiveVaultHit[]>()
  for (const hit of live) {
    const list = liveByPath.get(hit.vaultPath) ?? []
    list.push(hit)
    liveByPath.set(hit.vaultPath, list)
  }
  const canonicalByPath = new Map<string, VaultSearchHit[]>()
  for (const hit of canonical) {
    const list = canonicalByPath.get(hit.vaultPath) ?? []
    list.push(hit)
    canonicalByPath.set(hit.vaultPath, list)
  }
  const warnings: string[] = []
  for (const [path, canonHits] of canonicalByPath) {
    const liveHits = liveByPath.get(path)
    if (!liveHits) continue
    warnings.push(`live_confirms:${path}`)
    const canonExcerpts = canonHits.map((h) => h.excerpt)
    if (liveHits.some((lh) => clearlyDiffers(lh.excerpt, canonExcerpts))) warnings.push(possibleConflictWarning(path))
  }
  return warnings
}

/** Log-safe summary: counts and classes only — never a path, a query or note text. */
export function describeLiveEvidenceForLog(evidence: LiveEvidence, host: string | null): Record<string, unknown> {
  return { status: evidence.status, reason: evidence.reason, latencyMs: evidence.latencyMs, hits: evidence.hits.length, dropped: evidence.dropped, host }
}
