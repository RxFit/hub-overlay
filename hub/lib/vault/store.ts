import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { vaultChunks, vaultNotes, vaultSyncRuns } from '@/lib/schema'

/**
 * Persistence seam for the AntigravityHQ vault corpus.
 *
 * `VaultStore` is the ONLY way the sync engine and the search engine touch
 * Postgres. It exists as an interface so both can be tested fully offline
 * against test/vault-memory-store.ts (no Postgres, no pgvector); the Drizzle
 * implementation below is what the routes wire in.
 *
 * Contracts the implementations must keep (the sync/search tests assert them
 * against the memory store; tests/vault-store-db.test.ts against Postgres):
 *  - promoteNote is ATOMIC per note: upsert the note row, delete every old
 *    chunk of that note and insert the new set in ONE transaction. Either the
 *    new version is fully queryable or the old one still is — never a mix.
 *  - tombstoneNotes sets deleted_at and removes the chunks, keeping the row.
 *  - searchChunks only ever returns rows on the given embedding model and on
 *    non-tombstoned notes. Callers pass EMBEDDING_MODEL (lib/vector-store).
 */

export type VaultSyncRunStatus = 'running' | 'noop' | 'completed' | 'completed_with_failures' | 'incomplete' | 'failed'

/** Runs whose `to_commit` counts as "the index is at this commit". */
export const SUCCESSFUL_RUN_STATUSES: readonly VaultSyncRunStatus[] = ['noop', 'completed', 'completed_with_failures', 'incomplete']

export interface VaultNoteIndexRow {
  id: string
  vaultPath: string
  contentSha: string
  embeddingModel: string | null
  deletedAt: Date | null
}

export interface EmbeddedChunk {
  headingPath: string
  charStart: number
  charEnd: number
  content: string
  embedding: number[]
}

export interface PromoteNoteInput {
  tenantId: string
  corpus: string
  vaultPath: string
  noteTitle: string
  frontmatter: Record<string, unknown>
  contentSha: string
  indexedCommitSha: string
  embeddingModel: string
  sourceModifiedAt: Date | null
  indexedAt: Date
  chunks: EmbeddedChunk[]
}

export interface FailedPath {
  path: string
  message: string
}

export interface SyncRunStart {
  tenantId: string
  corpus: string
  startedAt: Date
  fromCommit: string | null
}

export interface SyncRunFinish {
  finishedAt: Date
  status: VaultSyncRunStatus
  toCommit: string | null
  notesScanned: number
  notesIndexed: number
  notesFailed: number
  failedPaths: FailedPath[]
  error: string | null
}

export interface VaultSyncRunRow {
  id: string
  startedAt: Date
  finishedAt: Date | null
  status: VaultSyncRunStatus
  fromCommit: string | null
  toCommit: string | null
  notesScanned: number
  notesIndexed: number
  notesFailed: number
  failedPaths: FailedPath[]
  error: string | null
}

export interface VaultSyncStatus {
  /** Most recent run of any status (may still be `running`). */
  lastRun: VaultSyncRunRow | null
  /** Most recent run that moved the index to a commit (see SUCCESSFUL_RUN_STATUSES). */
  lastSuccessfulRun: VaultSyncRunRow | null
  /** Non-tombstoned notes known to the index. */
  notesLive: number
  /** Non-tombstoned notes whose chunks are on the active embedding model. */
  notesOnActiveModel: number
  chunksOnActiveModel: number
}

export interface SearchChunksParams {
  tenantId: string
  corpus: string
  embeddingModel: string
  queryEmbedding: number[]
  topK: number
  pathPrefix?: string
}

export interface RawVaultHit {
  vaultPath: string
  noteTitle: string | null
  headingPath: string | null
  charStart: number
  charEnd: number
  content: string
  similarity: number
  contentSha: string
  indexedCommitSha: string | null
  sourceModifiedAt: Date | null
  indexedAt: Date
}

export interface VaultStore {
  listNoteIndex(tenantId: string, corpus: string): Promise<VaultNoteIndexRow[]>
  promoteNote(input: PromoteNoteInput): Promise<void>
  tombstoneNotes(tenantId: string, corpus: string, vaultPaths: string[], at: Date): Promise<number>
  startRun(input: SyncRunStart): Promise<string>
  finishRun(runId: string, patch: SyncRunFinish): Promise<void>
  getSyncStatus(tenantId: string, corpus: string, activeModel: string): Promise<VaultSyncStatus>
  searchChunks(params: SearchChunksParams): Promise<RawVaultHit[]>
}

function toRunRow(r: typeof vaultSyncRuns.$inferSelect): VaultSyncRunRow {
  return {
    id: r.id,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt ?? null,
    status: r.status as VaultSyncRunStatus,
    fromCommit: r.fromCommit ?? null,
    toCommit: r.toCommit ?? null,
    notesScanned: r.notesScanned,
    notesIndexed: r.notesIndexed,
    notesFailed: r.notesFailed,
    failedPaths: Array.isArray(r.failedPaths) ? r.failedPaths : [],
    error: r.error ?? null,
  }
}

/** The production store: Drizzle over the shared lazy `db` singleton. */
export function createDrizzleVaultStore(): VaultStore {
  return {
    async listNoteIndex(tenantId, corpus) {
      const rows = await db
        .select({
          id: vaultNotes.id,
          vaultPath: vaultNotes.vaultPath,
          contentSha: vaultNotes.contentSha,
          embeddingModel: vaultNotes.embeddingModel,
          deletedAt: vaultNotes.deletedAt,
        })
        .from(vaultNotes)
        .where(and(eq(vaultNotes.tenantId, tenantId), eq(vaultNotes.corpus, corpus)))
      return rows.map((r) => ({ ...r, embeddingModel: r.embeddingModel ?? null, deletedAt: r.deletedAt ?? null }))
    },

    async promoteNote(input) {
      await db.transaction(async (tx) => {
        const [note] = await tx
          .insert(vaultNotes)
          .values({
            tenantId: input.tenantId,
            corpus: input.corpus,
            vaultPath: input.vaultPath,
            noteTitle: input.noteTitle,
            frontmatter: input.frontmatter,
            contentSha: input.contentSha,
            indexedCommitSha: input.indexedCommitSha,
            embeddingModel: input.embeddingModel,
            sourceModifiedAt: input.sourceModifiedAt,
            indexedAt: input.indexedAt,
            deletedAt: null,
          })
          .onConflictDoUpdate({
            target: [vaultNotes.tenantId, vaultNotes.corpus, vaultNotes.vaultPath],
            set: {
              noteTitle: input.noteTitle,
              frontmatter: input.frontmatter,
              contentSha: input.contentSha,
              indexedCommitSha: input.indexedCommitSha,
              embeddingModel: input.embeddingModel,
              sourceModifiedAt: input.sourceModifiedAt,
              indexedAt: input.indexedAt,
              deletedAt: null,
            },
          })
          .returning({ id: vaultNotes.id })

        await tx.delete(vaultChunks).where(eq(vaultChunks.noteId, note.id))

        if (input.chunks.length > 0) {
          await tx.insert(vaultChunks).values(
            input.chunks.map((c) => ({
              noteId: note.id,
              tenantId: input.tenantId,
              corpus: input.corpus,
              vaultPath: input.vaultPath,
              headingPath: c.headingPath,
              charStart: c.charStart,
              charEnd: c.charEnd,
              content: c.content,
              embedding: c.embedding,
              embeddingModel: input.embeddingModel,
              contentSha: input.contentSha,
              indexedCommitSha: input.indexedCommitSha,
              indexedAt: input.indexedAt,
            })),
          )
        }
      })
    },

    async tombstoneNotes(tenantId, corpus, vaultPaths, at) {
      if (vaultPaths.length === 0) return 0
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(vaultNotes)
          .set({ deletedAt: at })
          .where(
            and(
              eq(vaultNotes.tenantId, tenantId),
              eq(vaultNotes.corpus, corpus),
              isNull(vaultNotes.deletedAt),
              inArray(vaultNotes.vaultPath, vaultPaths),
            ),
          )
          .returning({ id: vaultNotes.id })
        if (rows.length > 0) {
          await tx.delete(vaultChunks).where(inArray(vaultChunks.noteId, rows.map((r) => r.id)))
        }
        return rows.length
      })
    },

    async startRun(input) {
      const [row] = await db
        .insert(vaultSyncRuns)
        .values({
          tenantId: input.tenantId,
          corpus: input.corpus,
          startedAt: input.startedAt,
          status: 'running',
          fromCommit: input.fromCommit,
        })
        .returning({ id: vaultSyncRuns.id })
      return row.id
    },

    async finishRun(runId, patch) {
      await db
        .update(vaultSyncRuns)
        .set({
          finishedAt: patch.finishedAt,
          status: patch.status,
          toCommit: patch.toCommit,
          notesScanned: patch.notesScanned,
          notesIndexed: patch.notesIndexed,
          notesFailed: patch.notesFailed,
          failedPaths: patch.failedPaths,
          error: patch.error,
        })
        .where(eq(vaultSyncRuns.id, runId))
    },

    async getSyncStatus(tenantId, corpus, activeModel) {
      const scope = and(eq(vaultSyncRuns.tenantId, tenantId), eq(vaultSyncRuns.corpus, corpus))
      const [last] = await db.select().from(vaultSyncRuns).where(scope).orderBy(desc(vaultSyncRuns.startedAt)).limit(1)
      const [lastOk] = await db
        .select()
        .from(vaultSyncRuns)
        .where(and(scope, inArray(vaultSyncRuns.status, [...SUCCESSFUL_RUN_STATUSES]), isNotNull(vaultSyncRuns.toCommit)))
        .orderBy(desc(vaultSyncRuns.startedAt))
        .limit(1)
      const liveScope = and(eq(vaultNotes.tenantId, tenantId), eq(vaultNotes.corpus, corpus), isNull(vaultNotes.deletedAt))
      const [live] = await db.select({ n: count() }).from(vaultNotes).where(liveScope)
      const [onModel] = await db.select({ n: count() }).from(vaultNotes).where(and(liveScope, eq(vaultNotes.embeddingModel, activeModel)))
      const [chunks] = await db
        .select({ n: count() })
        .from(vaultChunks)
        .where(and(eq(vaultChunks.tenantId, tenantId), eq(vaultChunks.corpus, corpus), eq(vaultChunks.embeddingModel, activeModel)))
      return {
        lastRun: last ? toRunRow(last) : null,
        lastSuccessfulRun: lastOk ? toRunRow(lastOk) : null,
        notesLive: Number(live?.n ?? 0),
        notesOnActiveModel: Number(onModel?.n ?? 0),
        chunksOnActiveModel: Number(chunks?.n ?? 0),
      }
    },

    async searchChunks(params) {
      const vector = JSON.stringify(params.queryEmbedding)
      const distance = sql<number>`${vaultChunks.embedding} <=> ${vector}::vector`
      const similarity = sql<number>`1 - (${vaultChunks.embedding} <=> ${vector}::vector)`
      const conditions = [
        eq(vaultChunks.tenantId, params.tenantId),
        eq(vaultChunks.corpus, params.corpus),
        // ACTIVE model only — a stored vector is comparable only to a query
        // vector from the same model (lib/vector-store's rule, applied here).
        eq(vaultChunks.embeddingModel, params.embeddingModel),
        isNull(vaultNotes.deletedAt),
      ]
      if (params.pathPrefix) conditions.push(sql`starts_with(${vaultChunks.vaultPath}, ${params.pathPrefix})`)

      const rows = await db
        .select({
          vaultPath: vaultChunks.vaultPath,
          noteTitle: vaultNotes.noteTitle,
          headingPath: vaultChunks.headingPath,
          charStart: vaultChunks.charStart,
          charEnd: vaultChunks.charEnd,
          content: vaultChunks.content,
          similarity,
          contentSha: vaultChunks.contentSha,
          indexedCommitSha: vaultChunks.indexedCommitSha,
          sourceModifiedAt: vaultNotes.sourceModifiedAt,
          indexedAt: vaultChunks.indexedAt,
        })
        .from(vaultChunks)
        .innerJoin(vaultNotes, eq(vaultChunks.noteId, vaultNotes.id))
        .where(and(...conditions))
        .orderBy(distance)
        .limit(params.topK)

      return rows.map((r) => ({
        ...r,
        noteTitle: r.noteTitle ?? null,
        headingPath: r.headingPath ?? null,
        similarity: Number(r.similarity),
        indexedCommitSha: r.indexedCommitSha ?? null,
        sourceModifiedAt: r.sourceModifiedAt ?? null,
      }))
    },
  }
}
