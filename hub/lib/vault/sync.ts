import { chunkMarkdownNote, buildEmbeddingInput, type MarkdownChunkerOptions } from '@/lib/markdown-chunker'
import { swallow } from '@/lib/swallow'
import { createScopeMatcher, VAULT_CORPUS, type VaultScope } from './config'
import { describeError, VaultUnavailableError } from './errors'
import type { EmbedFn } from './embeddings'
import type { VaultGitHubClient } from './github'
import type { EmbeddedChunk, FailedPath, VaultStore, VaultSyncRunStatus } from './store'

/**
 * Incremental sync of the vault git snapshot into the corpus (Lane 1).
 *
 * One run = one commit. The engine reads HEAD and its recursive tree, keeps
 * the in-scope markdown blobs, and diffs them against vault_notes by GIT BLOB
 * SHA — so an unchanged note costs nothing, a changed note is re-embedded, a
 * vanished path (delete or rename) is tombstoned, and a note whose blob is
 * unchanged but whose chunks are on a retired embedding model is re-embedded
 * too. Re-running on an unchanged commit is a no-op that still records a run.
 *
 * ATOMIC PROMOTION PER NOTE. For each note: fetch blob → chunk → embed EVERY
 * chunk → then ONE store transaction replaces the old chunk set. A failure at
 * any point before that transaction (or inside it) leaves the previous
 * version fully queryable and marks the note failed in the run ledger
 * (`failed_paths`: path + message, never content). A failed note never fails
 * the run — unless failures are systemic (the embedding circuit opened, or
 * MAX_CONSECUTIVE_FAILURES in a row), in which case the run stops early as
 * `incomplete` instead of burning the budget on notes that cannot succeed.
 *
 * BUDGETS. `maxNotesPerRun` bounds a single request (Cloud Run's request
 * ceiling is 300s; a first index of a large vault is several runs) and the
 * optional `signal` is the run's wall-clock deadline. Both end the run as
 * `incomplete` with `notesRemaining` > 0; the next run picks up where this
 * one stopped because the diff is by SHA, not by run.
 *
 * LOGGING. Paths and counts only. Never note content, never the token.
 */

export const MAX_CONSECUTIVE_FAILURES = 5
export const DEFAULT_MAX_NOTES_PER_RUN = 200

export interface SyncLogger {
  info(obj: Record<string, unknown>, msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  debug(obj: Record<string, unknown>, msg: string): void
}

export interface VaultSyncDeps {
  store: VaultStore
  github: VaultGitHubClient
  embed: EmbedFn
  scope: VaultScope
  /** Git ref to read (branch/tag/HEAD). */
  ref: string
  /** The ACTIVE embedding model id — rows are tagged with it. */
  embeddingModel: string
  now?: () => Date
  log?: SyncLogger
  chunkOptions?: MarkdownChunkerOptions
  maxNotesPerRun?: number
  /** Resolve `source_modified_at` from git history (one extra request per changed note). Default true. */
  resolveSourceModified?: boolean
  /** Run deadline; when it fires, the run ends `incomplete`. */
  signal?: AbortSignal
}

export interface VaultSyncInput {
  tenantId: string
  corpus?: string
}

export interface VaultSyncResult {
  runId: string
  status: VaultSyncRunStatus
  fromCommit: string | null
  toCommit: string | null
  notesScanned: number
  notesIndexed: number
  notesFailed: number
  notesUnchanged: number
  notesTombstoned: number
  notesRemaining: number
  failedPaths: FailedPath[]
  durationMs: number
  /** Set when the run stopped early (deadline, circuit open, systemic failures). */
  stoppedEarly: string | null
}

const noopLog: SyncLogger = { info() {}, warn() {}, debug() {} }

/** A frontmatter `modified` / `updated` / `date` value, when it parses as a date. */
export function frontmatterDate(frontmatter: Record<string, unknown>): Date | null {
  for (const key of ['modified', 'updated', 'date', 'created']) {
    const v = frontmatter[key]
    if (typeof v !== 'string' && typeof v !== 'number') continue
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

export async function runVaultSync(input: VaultSyncInput, deps: VaultSyncDeps): Promise<VaultSyncResult> {
  const corpus = input.corpus ?? VAULT_CORPUS
  const tenantId = input.tenantId
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? noopLog
  const maxNotes = Math.max(1, deps.maxNotesPerRun ?? DEFAULT_MAX_NOTES_PER_RUN)
  const startedAt = now()
  const t0 = Date.now()

  const status = await deps.store.getSyncStatus(tenantId, corpus, deps.embeddingModel)
  const fromCommit = status.lastSuccessfulRun?.toCommit ?? null
  const runId = await deps.store.startRun({ tenantId, corpus, startedAt, fromCommit })

  const failedPaths: FailedPath[] = []
  let notesScanned = 0
  let notesIndexed = 0
  let notesUnchanged = 0
  let notesTombstoned = 0
  let notesRemaining = 0
  let toCommit: string | null = null
  let stoppedEarly: string | null = null

  const finish = async (runStatus: VaultSyncRunStatus, error: string | null) => {
    try {
      await deps.store.finishRun(runId, {
        finishedAt: now(),
        status: runStatus,
        toCommit,
        notesScanned,
        notesIndexed,
        notesFailed: failedPaths.length,
        failedPaths,
        error,
      })
    } catch (err) {
      // The ledger write is best-effort at this point: the result below still
      // tells the caller what happened, and the next run re-derives state from
      // the note table, not from this row.
      swallow(err, { module: 'vault-sync', op: 'finishRun', severity: 'degraded' })
    }
  }

  try {
    const head = await deps.github.getHead(deps.ref)
    toCommit = head.commitSha
    const tree = await deps.github.getTree(head.treeSha)
    if (tree.truncated) {
      // A truncated tree would make every missing path look deleted. Refuse.
      throw new VaultUnavailableError('github', 'integrity', 'GitHub returned a truncated tree; the vault is too large for the recursive tree API')
    }

    const matcher = createScopeMatcher(deps.scope)
    const inScope = tree.entries.filter((e) => e.type === 'blob' && matcher.matches(e.path))
    notesScanned = inScope.length
    log.info({ runId, commit: head.commitSha, treeEntries: tree.entries.length, inScope: inScope.length }, 'vault sync: tree read')
    log.debug({ runId, paths: inScope.map((e) => e.path) }, 'vault sync: in-scope paths')

    const existing = new Map((await deps.store.listNoteIndex(tenantId, corpus)).map((r) => [r.vaultPath, r]))
    const inScopePaths = new Set(inScope.map((e) => e.path))

    const toIndex = inScope.filter((e) => {
      const row = existing.get(e.path)
      if (!row || row.deletedAt) return true
      if (row.contentSha !== e.sha) return true
      if (row.embeddingModel !== deps.embeddingModel) return true
      return false
    })
    notesUnchanged = inScope.length - toIndex.length

    const toTombstone = [...existing.values()].filter((r) => !r.deletedAt && !inScopePaths.has(r.vaultPath)).map((r) => r.vaultPath)
    if (toTombstone.length > 0) {
      notesTombstoned = await deps.store.tombstoneNotes(tenantId, corpus, toTombstone, now())
      log.info({ runId, tombstoned: notesTombstoned, paths: toTombstone }, 'vault sync: tombstoned vanished paths')
    }

    const batch = toIndex.slice(0, maxNotes)
    notesRemaining = toIndex.length - batch.length
    let consecutiveFailures = 0

    for (let i = 0; i < batch.length; i++) {
      const entry = batch[i]
      if (deps.signal?.aborted) {
        stoppedEarly = 'deadline'
        notesRemaining = toIndex.length - i
        break
      }
      try {
        const content = await deps.github.getBlob(entry.sha)
        const parsed = chunkMarkdownNote(content, { ...deps.chunkOptions, path: entry.path })

        // Embed EVERY chunk before touching the store — the atomic-promotion rule.
        const embedded: EmbeddedChunk[] = []
        for (const chunk of parsed.chunks) {
          const embedding = await deps.embed(buildEmbeddingInput(parsed.title, chunk), { signal: deps.signal })
          embedded.push({ headingPath: chunk.headingPath, charStart: chunk.charStart, charEnd: chunk.charEnd, content: chunk.content, embedding })
        }

        let sourceModifiedAt = frontmatterDate(parsed.frontmatter.data)
        if (!sourceModifiedAt && (deps.resolveSourceModified ?? true)) {
          sourceModifiedAt = await deps.github.getLastCommitDate(entry.path, head.commitSha)
        }

        await deps.store.promoteNote({
          tenantId,
          corpus,
          vaultPath: entry.path,
          noteTitle: parsed.title,
          frontmatter: { ...parsed.frontmatter.data, aliases: parsed.frontmatter.aliases, tags: parsed.frontmatter.tags },
          contentSha: entry.sha,
          indexedCommitSha: head.commitSha,
          embeddingModel: deps.embeddingModel,
          sourceModifiedAt,
          indexedAt: now(),
          chunks: embedded,
        })
        notesIndexed++
        consecutiveFailures = 0
        log.debug({ runId, path: entry.path, chunks: embedded.length }, 'vault sync: note promoted')
      } catch (err) {
        const message = describeError(err)
        failedPaths.push({ path: entry.path, message })
        consecutiveFailures++
        log.warn({ runId, path: entry.path, message }, 'vault sync: note failed (previous version, if any, kept)')

        const systemic =
          (err instanceof VaultUnavailableError && err.reason === 'breaker_open') ||
          (err instanceof VaultUnavailableError && err.reason === 'timeout' && deps.signal?.aborted) ||
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
        if (systemic) {
          stoppedEarly = err instanceof VaultUnavailableError && err.reason === 'breaker_open'
            ? 'embedding circuit open'
            : deps.signal?.aborted
              ? 'deadline'
              : `${MAX_CONSECUTIVE_FAILURES} consecutive note failures`
          notesRemaining = toIndex.length - i - 1
          break
        }
      }
    }

    const nothingToDo = toIndex.length === 0 && toTombstone.length === 0
    const runStatus: VaultSyncRunStatus = nothingToDo
      ? 'noop'
      : notesRemaining > 0
        ? 'incomplete'
        : failedPaths.length > 0
          ? 'completed_with_failures'
          : 'completed'
    await finish(runStatus, stoppedEarly ? `stopped early: ${stoppedEarly}` : null)

    log.info(
      { runId, status: runStatus, toCommit, notesScanned, notesIndexed, notesFailed: failedPaths.length, notesUnchanged, notesTombstoned, notesRemaining, durationMs: Date.now() - t0 },
      'vault sync: run finished',
    )

    return {
      runId,
      status: runStatus,
      fromCommit,
      toCommit,
      notesScanned,
      notesIndexed,
      notesFailed: failedPaths.length,
      notesUnchanged,
      notesTombstoned,
      notesRemaining,
      failedPaths,
      durationMs: Date.now() - t0,
      stoppedEarly,
    }
  } catch (err) {
    // Run-level failure (GitHub unreachable, tree truncated, store outage).
    // Nothing indexed in this run is lost — promotions already committed stand.
    await finish('failed', describeError(err))
    log.warn({ runId, error: describeError(err) }, 'vault sync: run failed')
    throw err
  }
}
