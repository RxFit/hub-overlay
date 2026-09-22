import { createHash, randomUUID } from 'crypto'
import { breaker, CircuitOpenError } from '@/lib/circuit-breaker'
import { swallow } from '@/lib/swallow'
import { VAULT_CORPUS } from './config'
import { VaultUnavailableError } from './errors'
import type { EmbedFn } from './embeddings'
import type { RawVaultHit, VaultStore, VaultSyncStatus } from './store'

/**
 * Read-only semantic search over the vault corpus.
 *
 * Failure contract (lib/vertex.ts's, applied here): an empty result set is a
 * RESOLVED `hits: []`; unavailability (embedding outage, DB outage, an open
 * circuit) REJECTS with VaultUnavailableError and the route answers 503
 * `unavailable`. The two are never conflated — a harness told "no matches"
 * during an outage would conclude the note does not exist.
 *
 * Statuses a resolved search can carry, in precedence order:
 *   partial  the caller's `maxLatencyMs` deadline expired before the search
 *            finished — 200 with whatever was ready (usually nothing) and a
 *            warning, never a hang.
 *   stale    the index is older than `minFreshnessSeconds` (or has never been
 *            synced) — hits are still returned, with a warning naming the lag.
 *   fresh    otherwise.
 *
 * Two circuits: `vault-embeddings` (lib/vault/embeddings.ts) and `vault-db`
 * (this module), keyed separately from every other breaker so an outage here
 * cannot trip the chat path and vice versa.
 *
 * LOGGING: queryId, harness, tenant, query LENGTH and a SHA-256 of the query.
 * Never the query text, never note content.
 */

export const VAULT_DB_BREAKER_KEY = 'vault-db'
export const DEFAULT_TOP_K = 8
export const DEFAULT_MAX_LATENCY_MS = 8_000
export const MAX_LATENCY_CAP_MS = 10_000

export type VaultSearchStatus = 'fresh' | 'stale' | 'partial' | 'unavailable' | 'disabled' | 'awaiting_scope_config'

export interface VaultSearchRequest {
  query: string
  topK?: number
  pathPrefix?: string
  maxLatencyMs?: number
  minFreshnessSeconds?: number
}

export interface VaultSearchPrincipal {
  tenantId: string
  harness: string
}

export interface VaultSearchHit {
  vaultPath: string
  noteTitle: string | null
  headingPath: string | null
  charStart: number
  charEnd: number
  excerpt: string
  similarity: number
  contentSha: string
  indexedCommitSha: string | null
  sourceModifiedAt: string | null
  indexedAt: string
}

export interface VaultSearchSync {
  indexedCommitSha: string | null
  indexedAt: string | null
  syncLagSeconds: number | null
  coverage: { notesTotal: number; notesIndexed: number; notesFailed: number }
}

export interface VaultSearchResponse {
  queryId: string
  status: VaultSearchStatus
  warnings: string[]
  sync: VaultSearchSync
  hits: VaultSearchHit[]
}

export interface SearchLogger {
  info(obj: Record<string, unknown>, msg: string): void
  debug(obj: Record<string, unknown>, msg: string): void
}

export interface VaultSearchDeps {
  store: VaultStore
  embed: EmbedFn
  embeddingModel: string
  corpus?: string
  now?: () => Date
  log?: SearchLogger
  /** Injectable for tests; defaults to the global breaker under VAULT_DB_BREAKER_KEY. */
  dbExecute?: <T>(fn: () => Promise<T>) => Promise<T>
}

export function hashQuery(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex')
}

/** Coverage + provenance block built from the sync ledger. */
export function buildSyncBlock(status: VaultSyncStatus, now: Date): VaultSearchSync {
  const ok = status.lastSuccessfulRun
  const indexedAt = ok?.finishedAt ?? ok?.startedAt ?? null
  return {
    indexedCommitSha: ok?.toCommit ?? null,
    indexedAt: indexedAt ? indexedAt.toISOString() : null,
    syncLagSeconds: indexedAt ? Math.max(0, Math.round((now.getTime() - indexedAt.getTime()) / 1000)) : null,
    coverage: {
      notesTotal: ok?.notesScanned ?? status.notesLive,
      notesIndexed: status.notesOnActiveModel,
      notesFailed: status.lastRun?.notesFailed ?? 0,
    },
  }
}

type Raced<T> = { timedOut: true } | { timedOut: false; value: T }

/** Race a promise against a deadline; a late settle is swallowed, never unhandled. */
async function raceDeadline<T>(work: Promise<T>, deadlineAt: number, now: () => number, op: string): Promise<Raced<T>> {
  const remaining = deadlineAt - now()
  if (remaining <= 0) {
    void work.catch((err: unknown) => swallow(err, { module: 'vault-search', op: `${op}:afterDeadline`, severity: 'expected' }))
    return { timedOut: true }
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), remaining)
  })
  try {
    return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    void work.catch((err: unknown) => swallow(err, { module: 'vault-search', op: `${op}:lateRejection`, severity: 'expected' }))
  }
}

function toHit(raw: RawVaultHit): VaultSearchHit {
  return {
    vaultPath: raw.vaultPath,
    noteTitle: raw.noteTitle,
    headingPath: raw.headingPath,
    charStart: raw.charStart,
    charEnd: raw.charEnd,
    excerpt: raw.content,
    similarity: Number(raw.similarity.toFixed(6)),
    contentSha: raw.contentSha,
    indexedCommitSha: raw.indexedCommitSha,
    sourceModifiedAt: raw.sourceModifiedAt ? raw.sourceModifiedAt.toISOString() : null,
    indexedAt: raw.indexedAt.toISOString(),
  }
}

/**
 * Run one search. Resolves with a 200-shaped response (`fresh` / `stale` /
 * `partial`); REJECTS with VaultUnavailableError when the answer is unknown.
 */
export async function searchVault(
  request: VaultSearchRequest,
  principal: VaultSearchPrincipal,
  deps: VaultSearchDeps,
): Promise<VaultSearchResponse> {
  const corpus = deps.corpus ?? VAULT_CORPUS
  const now = deps.now ?? (() => new Date())
  const clock = () => now().getTime()
  const queryId = randomUUID()
  const topK = Math.min(20, Math.max(1, request.topK ?? DEFAULT_TOP_K))
  const maxLatencyMs = Math.min(MAX_LATENCY_CAP_MS, Math.max(1, request.maxLatencyMs ?? DEFAULT_MAX_LATENCY_MS))
  const startedAt = clock()
  const deadlineAt = startedAt + maxLatencyMs
  const warnings: string[] = []
  const dbExecute = deps.dbExecute ?? (<T>(fn: () => Promise<T>) => breaker.execute(VAULT_DB_BREAKER_KEY, fn))
  const logBase = {
    queryId,
    harness: principal.harness,
    tenant: principal.tenantId,
    queryLength: request.query.length,
    queryHash: hashQuery(request.query),
  }

  const wrapDb = <T>(fn: () => Promise<T>): Promise<T> =>
    dbExecute(fn).catch((err: unknown) => {
      if (err instanceof VaultUnavailableError) throw err
      if (err instanceof CircuitOpenError) throw new VaultUnavailableError('db', 'breaker_open', 'Vault DB circuit is open after repeated failures')
      throw new VaultUnavailableError('db', 'internal', `Vault index query failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
    })

  // The sync ledger read and the query embedding are independent — overlap them.
  const deadlineController = new AbortController()
  const deadlineTimer = setTimeout(() => deadlineController.abort(), maxLatencyMs)
  const syncWork = wrapDb(() => deps.store.getSyncStatus(principal.tenantId, corpus, deps.embeddingModel))
  const embedWork = deps.embed(request.query, { signal: deadlineController.signal })

  let status: VaultSearchStatus = 'fresh'
  let hits: VaultSearchHit[] = []
  let sync: VaultSearchSync
  let ledger: VaultSyncStatus | null = null

  try {
    const syncRaced = await raceDeadline(syncWork, deadlineAt, clock, 'syncStatus')
    if (syncRaced.timedOut) {
      // Without the ledger we cannot even describe the index; treat as partial
      // with an empty provenance block rather than guessing.
      void embedWork.catch((err: unknown) => swallow(err, { module: 'vault-search', op: 'embed:afterDeadline', severity: 'expected' }))
      status = 'partial'
      warnings.push(`maxLatencyMs (${maxLatencyMs}) expired before the sync ledger answered; no hits returned`)
      sync = { indexedCommitSha: null, indexedAt: null, syncLagSeconds: null, coverage: { notesTotal: 0, notesIndexed: 0, notesFailed: 0 } }
    } else {
      ledger = syncRaced.value
      sync = buildSyncBlock(ledger, now())

      const embedRaced = await raceDeadline(embedWork, deadlineAt, clock, 'embed')
      if (embedRaced.timedOut) {
        status = 'partial'
        warnings.push(`maxLatencyMs (${maxLatencyMs}) expired while embedding the query; no hits returned`)
      } else {
        const queryEmbedding = embedRaced.value
        const searchWork = wrapDb(() =>
          deps.store.searchChunks({
            tenantId: principal.tenantId,
            corpus,
            embeddingModel: deps.embeddingModel,
            queryEmbedding,
            topK,
            pathPrefix: request.pathPrefix || undefined,
          }),
        )
        const searchRaced = await raceDeadline(searchWork, deadlineAt, clock, 'searchChunks')
        if (searchRaced.timedOut) {
          status = 'partial'
          warnings.push(`maxLatencyMs (${maxLatencyMs}) expired during the index query; no hits returned`)
        } else {
          hits = searchRaced.value.map(toHit)
        }
      }
    }
  } catch (err) {
    clearTimeout(deadlineTimer)
    // Unavailability propagates as-is (503). Anything else is still "unknown
    // answer", never "no matches".
    if (err instanceof VaultUnavailableError) {
      deps.log?.info({ ...logBase, status: 'unavailable', stage: err.stage, reason: err.reason, durationMs: clock() - startedAt }, 'vault search: unavailable')
      throw err
    }
    throw new VaultUnavailableError('db', 'internal', `Vault search failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
  clearTimeout(deadlineTimer)

  // Freshness: only downgrade a result we actually produced.
  if (status !== 'partial') {
    if (sync.syncLagSeconds === null) {
      status = 'stale'
      warnings.push('the vault index has no completed sync yet; results reflect an empty or partial index')
    } else if (request.minFreshnessSeconds !== undefined && sync.syncLagSeconds > request.minFreshnessSeconds) {
      status = 'stale'
      warnings.push(`index is ${sync.syncLagSeconds}s old, older than the requested minFreshnessSeconds (${request.minFreshnessSeconds})`)
    }
  }
  const last = lastRunNote(ledger)
  if (last) warnings.push(last)

  deps.log?.info({ ...logBase, status, hits: hits.length, topK, durationMs: clock() - startedAt }, 'vault search: completed')

  return { queryId, status, warnings, sync, hits }
}

/** One warning line when the last run left work behind — from the already-resolved ledger read only. */
function lastRunNote(ledger: VaultSyncStatus | null): string | null {
  const r = ledger?.lastRun
  if (!r) return null
  if (r.status === 'failed') return `the last sync run failed${r.error ? ` (${r.error})` : ''}; the index may lag the vault`
  if (r.status === 'incomplete') return 'the last sync run stopped before indexing every changed note; the index may lag the vault'
  if (r.status === 'completed_with_failures' && r.notesFailed > 0) return `${r.notesFailed} note(s) failed to index in the last sync run`
  return null
}
