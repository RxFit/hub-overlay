/**
 * One source's sync run: exposure guard → window → collect → write content →
 * write manifest → start the Discovery Engine import → advance the cursor.
 *
 * ── Exposure guard: never import into the chat engine ──
 * The Hub chat searches the whole Semantic Brain engine (VERTEX_ENGINE_ID)
 * with no data-store scoping and no per-role authorization, and every role
 * that can chat — including `onboarding` — reaches it. Mailbox contents and
 * Stripe billing records must not land there. So before touching anything,
 * a run reads the chat engine's connected data stores and REFUSES to import
 * into one of them (stage `config`), failing closed if the engine cannot be
 * read. Surfacing these records in chat is a separate, role-gated retrieval
 * change — not something this pipeline may do by configuration alone.
 *
 * ── Why a cursor, not "the last 24 hours" ──
 * The trigger is a scheduled GitHub Actions workflow, and GitHub drops
 * scheduled firings (2–10 hours of hourly ticks were lost on 2026-08-27 — see
 * .github/workflows/dispatch-alert.yml). A fixed 24h window turns one dropped
 * night into a permanent hole. Instead each source keeps a cursor in its own
 * bucket (`<prefix>/<source>/_state.json`): the next run starts where the last
 * COMPLETE run ended (minus an overlap for late-arriving mail), so a missed
 * night is caught up on the next firing, bounded by MAX_CATCHUP_HOURS.
 *
 * ── Failure ordering ──
 * The cursor is written LAST. Any failure before it (collect, upload, import
 * start) leaves the cursor where it was, so the next run re-covers the same
 * window. That is safe because every write is idempotent: content objects are
 * overwritten in place and the import is INCREMENTAL (same id = replace).
 *
 * ── The asynchronous import: a queue, not a slot ──
 * documents:import is a long-running operation that finishes after this
 * request returns, and the cursor has already moved past its records — so an
 * import that is never confirmed is data silently missing from the index.
 * Every started import is therefore kept in `state.imports` until it
 * SUCCEEDS. Each run checks every queued operation:
 *   - running            → stays queued;
 *   - succeeded          → dropped;
 *   - failed or partial  → each of its manifests is re-imported with this
 *                          run's import (INCREMENTAL, so already-indexed
 *                          documents are merely replaced), up to
 *                          MAX_IMPORT_ATTEMPTS per manifest;
 *   - unreadable         → stays queued, and after MAX_CHECK_FAILURES
 *                          consecutive misses is treated as failed.
 * A manifest out of attempts is ABANDONED: recorded in `state.abandoned` and
 * the run reports `failed` (HTTP 502 → the workflow fails) even though its own
 * new records were written and the cursor advanced.
 */

import { ServiceAccountTokenError } from '@/lib/google-auth'
import type { SourceConfig, SyncSourceId } from './config'
import { manifestLine, renderHtml } from './documents'
import type { ImportOutcome, Importer } from './discovery-import'
import type { ObjectStore } from './gcs'
import { SemanticSyncError, mapLimit, type SyncStage } from './http'
import type { SyncSource } from './source'

const HOUR = 3_600_000
/** First run with no cursor. */
export const DEFAULT_FIRST_LOOKBACK_HOURS = 24
/** Automatic catch-up never reaches further back than this. */
export const MAX_CATCHUP_HOURS = 24 * 14
/** Explicit backfill ceiling (Stripe keeps events for 30 days). */
export const MAX_LOOKBACK_HOURS = 24 * 30
/** Re-read this much before the cursor after a complete run (late-delivered mail). */
export const OVERLAP_MS = HOUR
export const DEFAULT_MAX_ITEMS = 300
export const MAX_ITEMS_CEILING = 1000
/** Import attempts per manifest before it is abandoned. */
export const MAX_IMPORT_ATTEMPTS = 3
/** Consecutive unreadable checks before a queued operation is treated as failed. */
export const MAX_CHECK_FAILURES = 3
/** Abandoned manifests kept in state for the admin status route. */
const MAX_ABANDONED_KEPT = 50
const UPLOAD_CONCURRENCY = 8

export interface QueuedImport {
  operation: string
  /** Each manifest carries its own attempt count (1 = first import). */
  manifests: Array<{ uri: string; attempts: number }>
  startedAt: string
  /** Consecutive runs whose check of this operation failed. */
  checkFailures?: number
}

export interface SyncState {
  version: 1
  /** ISO time up to which records have been written and an import started. */
  cursor?: string
  /** The last run stopped at maxItems — resume exactly at the cursor. */
  lastRunTruncated?: boolean
  lastSuccessAt?: string
  /** Every import not yet confirmed successful. */
  imports?: QueuedImport[]
  /** Manifests that exhausted MAX_IMPORT_ATTEMPTS — in GCS, NOT in the index. */
  abandoned?: string[]
}

export interface ImportReport {
  operation: string
  /**
   * running / unknown: still queued · succeeded: dropped from the queue ·
   * retrying: its manifests ride this run's import · abandoned: at least one
   * of its manifests is out of attempts.
   */
  status: 'running' | 'unknown' | 'succeeded' | 'retrying' | 'abandoned'
  successCount?: number
  failureCount?: number
  errors?: string[]
  detail?: string
}

export interface SourceRunResult {
  source: SyncSourceId
  status: 'synced' | 'noop' | 'dry_run' | 'not_configured' | 'failed'
  /** not_configured: env vars to set. */
  missing?: string[]
  location?: string
  window?: { since: string; until: string; clamped: boolean }
  scanned?: number
  documents?: number
  truncated?: boolean
  cursor?: string
  manifest?: string
  import?: { status: 'started' | 'skipped'; operation?: string; manifests?: number; detail?: string }
  /** What happened to each import queued by earlier runs. */
  previousImports?: ImportReport[]
  /** Manifests abandoned by THIS run (they make the run `failed`). */
  abandonedManifests?: string[]
  /** dry_run: the document ids that would have been written. */
  sampleIds?: string[]
  failure?: { stage: SyncStage; detail: string; httpStatus?: number }
  durationMs: number
}

export interface RunOptions {
  dryRun?: boolean
  /** Explicit backfill: ignore the cursor and start this many hours back. */
  lookbackHours?: number
  maxItems?: number
}

export interface SourceRunDeps {
  config: SourceConfig
  source: SyncSource
  store: ObjectStore
  importer: Importer
  /** Full resource path of the engine the Hub chat searches — never import into it. */
  chatEngine: string
  now?: () => Date
  signal?: AbortSignal
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/')
}

/** Exported for tests. */
export function computeWindow(
  state: SyncState | null,
  now: Date,
  lookbackHours?: number,
): { since: Date; until: Date; clamped: boolean } {
  const until = now
  let since: Date
  if (lookbackHours) {
    since = new Date(now.getTime() - lookbackHours * HOUR)
  } else if (state?.cursor && !Number.isNaN(Date.parse(state.cursor))) {
    const cursor = Date.parse(state.cursor)
    // After a truncated run resume at the cursor (1s back for same-second
    // records) so the next run always makes progress; after a complete run
    // re-read an hour for mail delivered with an earlier timestamp.
    since = new Date(cursor - (state.lastRunTruncated ? 1000 : OVERLAP_MS))
  } else {
    since = new Date(now.getTime() - DEFAULT_FIRST_LOOKBACK_HOURS * HOUR)
  }
  // Continuing a truncated run (e.g. a 30-day backfill that stopped at
  // maxItems) gets the backfill ceiling, not the catch-up one — clamping it at
  // 14 days would silently skip the rest of the backfill.
  const ceiling = lookbackHours || state?.lastRunTruncated ? MAX_LOOKBACK_HOURS : MAX_CATCHUP_HOURS
  const floor = now.getTime() - ceiling * HOUR
  const clamped = since.getTime() < floor
  if (clamped) since = new Date(floor)
  return { since, until, clamped }
}

/** `projects/p/…/dataStores/ds` or `…/engines/e` → { project, id }. */
function resourceParts(path: string): { project: string; id: string } {
  const segs = path.split('/')
  return { project: segs[1] ?? '', id: segs[segs.length - 1] ?? '' }
}

/**
 * True when `dataStore` is one of the chat engine's connected data stores.
 * An engine can only connect data stores of its own project, so a store in
 * another project is never attached. Exported for tests.
 */
export function isConnectedToEngine(dataStore: string, engine: string, engineDataStoreIds: string[]): boolean {
  const ds = resourceParts(dataStore)
  return ds.project === resourceParts(engine).project && engineDataStoreIds.includes(ds.id)
}

async function assertNotChatVisible(deps: SourceRunDeps, dataStore: string): Promise<void> {
  let ids: string[]
  try {
    ids = await deps.importer.engineDataStoreIds(deps.chatEngine)
  } catch (err) {
    // Fail CLOSED: an unverifiable engine is not permission to import.
    throw new SemanticSyncError(
      'config',
      `could not verify that ${dataStore} is not searchable by the Hub chat (reading ${deps.chatEngine} failed: ${err instanceof Error ? err.message : String(err)}) — refusing to import`,
      err instanceof SemanticSyncError ? err.httpStatus : undefined,
    )
  }
  if (isConnectedToEngine(dataStore, deps.chatEngine, ids)) {
    throw new SemanticSyncError(
      'config',
      `${dataStore} is connected to the Hub chat engine ${deps.chatEngine}, which every chat-enabled role (including onboarding) searches unscoped — refusing to import ${deps.config.source} records into it. Use a data store that is NOT connected to that engine (hub/docs/runbooks/semantic-sync.md §2).`,
    )
  }
}

function classify(outcome: ImportOutcome): 'running' | 'succeeded' | 'incomplete' {
  if (!outcome.done) return 'running'
  const incomplete = (outcome.failureCount ?? 0) > 0 || !!outcome.errors?.length
  return incomplete ? 'incomplete' : 'succeeded'
}

/**
 * Check every queued import. Returns the operations still to watch, the
 * manifests to re-import this run, and the ones out of attempts.
 */
async function reviewQueue(
  queue: QueuedImport[],
  importer: Importer,
): Promise<{
  pending: QueuedImport[]
  retry: Array<{ uri: string; attempts: number }>
  abandoned: string[]
  reports: ImportReport[]
}> {
  const pending: QueuedImport[] = []
  const retry: Array<{ uri: string; attempts: number }> = []
  const abandoned: string[] = []
  const reports: ImportReport[] = []

  for (const queued of queue) {
    let outcome: ImportOutcome | null = null
    let detail: string | undefined
    try {
      outcome = await importer.check(queued.operation)
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err)
      const checkFailures = (queued.checkFailures ?? 0) + 1
      if (checkFailures < MAX_CHECK_FAILURES) {
        pending.push({ ...queued, checkFailures })
        reports.push({ operation: queued.operation, status: 'unknown', detail })
        continue
      }
      // Unreadable for too long (expired or deleted operation): the only safe
      // assumption is that it did not land. Re-importing is idempotent.
    }

    const verdict = outcome ? classify(outcome) : 'incomplete'
    const counts = outcome
      ? { successCount: outcome.successCount, failureCount: outcome.failureCount, errors: outcome.errors }
      : {}
    if (verdict === 'running') {
      pending.push({ ...queued, checkFailures: 0 })
      reports.push({ operation: queued.operation, status: 'running' })
      continue
    }
    if (verdict === 'succeeded') {
      reports.push({ operation: queued.operation, status: 'succeeded', ...counts })
      continue
    }

    let lost = false
    for (const m of queued.manifests) {
      if (m.attempts < MAX_IMPORT_ATTEMPTS) retry.push(m)
      else {
        abandoned.push(m.uri)
        lost = true
      }
    }
    reports.push({
      operation: queued.operation,
      status: lost ? 'abandoned' : 'retrying',
      ...counts,
      ...(detail ? { detail: `operation unreadable ${MAX_CHECK_FAILURES} runs in a row: ${detail}` } : {}),
    })
  }

  return { pending, retry, abandoned, reports }
}

/** Deny by default: a source missing configuration touches nothing. */
export function notConfiguredResult(config: SourceConfig): SourceRunResult {
  return { source: config.source, status: 'not_configured', missing: config.missing, durationMs: 0 }
}

export async function runSourceSync(deps: SourceRunDeps, opts: RunOptions = {}): Promise<SourceRunResult> {
  const started = Date.now()
  const { config } = deps
  if (!config.ready || !config.location) return notConfiguredResult(config)
  const result: SourceRunResult = { source: config.source, status: 'failed', durationMs: 0 }

  const base = join(config.location.prefix, config.source)
  const stateName = join(base, '_state.json')
  result.location = deps.store.uri(base)
  const now = (deps.now ?? (() => new Date()))()
  const maxItems = Math.min(Math.max(1, opts.maxItems ?? DEFAULT_MAX_ITEMS), MAX_ITEMS_CEILING)

  // The stage in progress, for failures that do not name their own (an abort
  // at the run deadline, an unexpected throw).
  let stage: SyncStage = 'config'
  try {
    if (config.dataStore) await assertNotChatVisible(deps, config.dataStore)

    stage = 'state'
    const state = await deps.store.getJson<SyncState>(stateName)

    // Settle what earlier runs started before deciding this run's inputs.
    let queue = state?.imports ?? []
    let retry: Array<{ uri: string; attempts: number }> = []
    let abandoned: string[] = []
    if (config.dataStore && queue.length) {
      stage = 'import'
      const reviewed = await reviewQueue(queue, deps.importer)
      queue = reviewed.pending
      retry = reviewed.retry
      abandoned = reviewed.abandoned
      result.previousImports = reviewed.reports
      if (abandoned.length) result.abandonedManifests = abandoned
    }

    const window = computeWindow(state, now, opts.lookbackHours)
    result.window = { since: window.since.toISOString(), until: window.until.toISOString(), clamped: window.clamped }

    stage = 'collect'
    const collected = await deps.source.collect(window, { maxItems, signal: deps.signal })
    result.scanned = collected.scanned
    result.documents = collected.docs.length
    result.truncated = collected.truncated
    result.cursor = collected.cursor.toISOString()

    if (opts.dryRun) {
      return {
        ...result,
        status: 'dry_run',
        sampleIds: collected.docs.slice(0, 20).map((d) => d.id),
        durationMs: Date.now() - started,
      }
    }

    // Content first, manifest second: a manifest must never name an object
    // that is not there yet.
    stage = 'upload'
    let manifestUri: string | undefined
    if (collected.docs.length) {
      const lines = await mapLimit(collected.docs, UPLOAD_CONCURRENCY, async (doc) => {
        const name = join(base, 'docs', `${doc.id}.html`)
        await deps.store.put(name, renderHtml(doc), 'text/html; charset=utf-8')
        return manifestLine(doc, deps.store.uri(name))
      })
      const manifestName = join(base, 'manifests', `${now.toISOString().replace(/[:.]/g, '-')}.jsonl`)
      await deps.store.put(manifestName, `${lines.join('\n')}\n`, 'application/x-ndjson')
      manifestUri = deps.store.uri(manifestName)
      result.manifest = manifestUri
    }

    const inputs = [
      ...retry.map((m) => ({ uri: m.uri, attempts: m.attempts + 1 })),
      ...(manifestUri ? [{ uri: manifestUri, attempts: 1 }] : []),
    ]
    if (!config.dataStore) {
      result.import = {
        status: 'skipped',
        detail: `no data store configured — objects are in GCS but NOT imported into Vertex AI Search (set SEMANTIC_SYNC_${config.source.toUpperCase()}_DATA_STORE)`,
      }
    } else if (inputs.length) {
      stage = 'import'
      const operation = await deps.importer.start(config.dataStore, inputs.map((m) => m.uri))
      result.import = { status: 'started', operation, manifests: inputs.length }
      queue = [...queue, { operation, manifests: inputs, startedAt: now.toISOString() }]
    } else {
      result.import = { status: 'skipped', detail: 'nothing new to import' }
    }

    const next: SyncState = {
      version: 1,
      cursor: collected.cursor.toISOString(),
      lastRunTruncated: collected.truncated,
      lastSuccessAt: now.toISOString(),
      ...(queue.length ? { imports: queue } : {}),
      ...(state?.abandoned?.length || abandoned.length
        ? { abandoned: [...(state?.abandoned ?? []), ...abandoned].slice(-MAX_ABANDONED_KEPT) }
        : {}),
    }
    stage = 'state'
    await deps.store.put(stateName, JSON.stringify(next, null, 2), 'application/json')

    if (abandoned.length) {
      // This run's own records landed and the cursor moved; the failure is
      // about earlier records that will now never be indexed automatically.
      return {
        ...result,
        status: 'failed',
        failure: {
          stage: 'import',
          detail: `${abandoned.length} manifest(s) failed to import ${MAX_IMPORT_ATTEMPTS} times and were abandoned — those records are in GCS but not in the index (runbook: "Import failures")`,
        },
        durationMs: Date.now() - started,
      }
    }
    return { ...result, status: collected.docs.length ? 'synced' : 'noop', durationMs: Date.now() - started }
  } catch (err) {
    const failedStage: SyncStage =
      err instanceof SemanticSyncError ? err.stage : err instanceof ServiceAccountTokenError ? 'auth' : stage
    const httpStatus =
      err instanceof SemanticSyncError || err instanceof ServiceAccountTokenError ? err.httpStatus : undefined
    const aborted = deps.signal?.aborted || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
    return {
      ...result,
      status: 'failed',
      failure: {
        stage: failedStage,
        detail: aborted
          ? `run deadline reached during ${failedStage} — the cursor did not move; the next run retries this window (a smaller maxItems finishes sooner)`
          : err instanceof Error ? err.message : String(err),
        ...(httpStatus ? { httpStatus } : {}),
      },
      durationMs: Date.now() - started,
    }
  }
}
