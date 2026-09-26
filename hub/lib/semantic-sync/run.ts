/**
 * One source's sync run: window → collect → write content → write manifest →
 * start the Discovery Engine import → advance the cursor.
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
 * ── The asynchronous import ──
 * documents:import is a long-running operation that finishes after this
 * request returns. The next run reads it back; if it FAILED outright its
 * manifests are re-imported alongside the new one (up to MAX_IMPORT_ATTEMPTS),
 * because the cursor has already moved past those records and nothing else
 * would ever index them.
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
const MAX_IMPORT_ATTEMPTS = 3
const UPLOAD_CONCURRENCY = 8

export interface SyncState {
  version: 1
  /** ISO time up to which records have been written and an import started. */
  cursor?: string
  /** The last run stopped at maxItems — resume exactly at the cursor. */
  lastRunTruncated?: boolean
  lastSuccessAt?: string
  lastImport?: {
    operation: string
    manifests: string[]
    attempts: number
    startedAt: string
  }
}

export interface PreviousImport {
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'abandoned' | 'unknown'
  operation: string
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
  import?: { status: 'started' | 'skipped' | 'retrying_previous'; operation?: string; detail?: string }
  previousImport?: PreviousImport
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

function classifyPrevious(outcome: ImportOutcome, attempts: number): PreviousImport {
  const base = {
    operation: outcome.operation,
    successCount: outcome.successCount,
    failureCount: outcome.failureCount,
    errors: outcome.errors,
  }
  if (!outcome.done) return { ...base, status: 'running' }
  const failedOutright = (outcome.successCount ?? 0) === 0 && ((outcome.failureCount ?? 0) > 0 || !!outcome.errors?.length)
  if (failedOutright) return { ...base, status: attempts >= MAX_IMPORT_ATTEMPTS ? 'abandoned' : 'failed' }
  if ((outcome.failureCount ?? 0) > 0) return { ...base, status: 'partial' }
  return { ...base, status: 'succeeded' }
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
  let stage: SyncStage = 'state'
  try {
    const state = await deps.store.getJson<SyncState>(stateName)

    // Read back the previous run's import before deciding this run's inputs.
    let carry: string[] = []
    if (state?.lastImport && config.dataStore) {
      try {
        const outcome = await deps.importer.check(state.lastImport.operation)
        result.previousImport = classifyPrevious(outcome, state.lastImport.attempts)
        if (result.previousImport.status === 'failed') carry = state.lastImport.manifests
      } catch (err) {
        // Diagnostics only — an unreadable operation must not block new data.
        result.previousImport = {
          status: 'unknown',
          operation: state.lastImport.operation,
          detail: err instanceof Error ? err.message : String(err),
        }
      }
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

    const inputs = [...carry, ...(manifestUri ? [manifestUri] : [])]
    let lastImport = state?.lastImport
    if (!config.dataStore) {
      result.import = {
        status: 'skipped',
        detail: `no data store configured — objects are in GCS but NOT imported into Vertex AI Search (set SEMANTIC_SYNC_${config.source.toUpperCase()}_DATA_STORE)`,
      }
    } else if (inputs.length) {
      stage = 'import'
      const operation = await deps.importer.start(config.dataStore, inputs)
      result.import = { status: carry.length ? 'retrying_previous' : 'started', operation }
      lastImport = {
        operation,
        manifests: inputs,
        attempts: carry.length ? (state?.lastImport?.attempts ?? 1) + 1 : 1,
        startedAt: now.toISOString(),
      }
    } else {
      result.import = { status: 'skipped', detail: 'nothing new to import' }
    }

    const next: SyncState = {
      version: 1,
      cursor: collected.cursor.toISOString(),
      lastRunTruncated: collected.truncated,
      lastSuccessAt: now.toISOString(),
      ...(lastImport ? { lastImport } : {}),
    }
    stage = 'state'
    await deps.store.put(stateName, JSON.stringify(next, null, 2), 'application/json')

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
