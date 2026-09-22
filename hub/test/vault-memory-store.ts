import type {
  EmbeddedChunk,
  PromoteNoteInput,
  RawVaultHit,
  SearchChunksParams,
  SyncRunFinish,
  SyncRunStart,
  VaultNoteIndexRow,
  VaultStore,
  VaultSyncRunRow,
  VaultSyncStatus,
} from '@/lib/vault/store'
import { SUCCESSFUL_RUN_STATUSES } from '@/lib/vault/store'

/**
 * In-memory VaultStore for the offline sync/search/route tests.
 *
 * Keeps the same contracts as the Drizzle store (atomic promote, tombstones
 * that drop chunks, active-model-only search) so the engines are exercised
 * for real — only the persistence is fake. `failPromoteFor` lets a test make
 * the "one transaction" step itself blow up for a path, to prove the previous
 * version survives a mid-promotion failure too.
 */

interface NoteRecord {
  id: string
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
  deletedAt: Date | null
}

interface ChunkRecord extends EmbeddedChunk {
  noteId: string
  tenantId: string
  corpus: string
  vaultPath: string
  embeddingModel: string
  contentSha: string
  indexedCommitSha: string
  indexedAt: Date
}

export interface MemoryVaultStore extends VaultStore {
  notes: Map<string, NoteRecord>
  chunks: ChunkRecord[]
  runs: VaultSyncRunRow[]
  /** Paths for which promoteNote throws (simulated transaction failure). */
  failPromoteFor: Set<string>
  /** When set, every DB method rejects with this error (simulated outage). */
  outage: Error | null
  chunksFor(vaultPath: string): ChunkRecord[]
  note(vaultPath: string): NoteRecord | undefined
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

let seq = 0
const nextId = (prefix: string) => `${prefix}-${++seq}`

export function createMemoryVaultStore(): MemoryVaultStore {
  const notes = new Map<string, NoteRecord>()
  const store: MemoryVaultStore = {
    notes,
    chunks: [],
    runs: [],
    failPromoteFor: new Set(),
    outage: null,

    chunksFor(vaultPath) {
      return store.chunks.filter((c) => c.vaultPath === vaultPath)
    },
    note(vaultPath) {
      return [...notes.values()].find((n) => n.vaultPath === vaultPath)
    },

    async listNoteIndex(tenantId, corpus): Promise<VaultNoteIndexRow[]> {
      if (store.outage) throw store.outage
      return [...notes.values()]
        .filter((n) => n.tenantId === tenantId && n.corpus === corpus)
        .map((n) => ({ id: n.id, vaultPath: n.vaultPath, contentSha: n.contentSha, embeddingModel: n.embeddingModel, deletedAt: n.deletedAt }))
    },

    async promoteNote(input: PromoteNoteInput) {
      if (store.outage) throw store.outage
      if (store.failPromoteFor.has(input.vaultPath)) throw new Error(`simulated transaction failure for ${input.vaultPath}`)
      const key = `${input.tenantId}/${input.corpus}/${input.vaultPath}`
      const existing = notes.get(key)
      const id = existing?.id ?? nextId('note')
      // "One transaction": replace note + chunks together.
      notes.set(key, {
        id,
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
      store.chunks = store.chunks.filter((c) => c.noteId !== id)
      for (const c of input.chunks) {
        store.chunks.push({
          ...c,
          noteId: id,
          tenantId: input.tenantId,
          corpus: input.corpus,
          vaultPath: input.vaultPath,
          embeddingModel: input.embeddingModel,
          contentSha: input.contentSha,
          indexedCommitSha: input.indexedCommitSha,
          indexedAt: input.indexedAt,
        })
      }
    },

    async tombstoneNotes(tenantId, corpus, vaultPaths, at) {
      if (store.outage) throw store.outage
      let n = 0
      for (const note of notes.values()) {
        if (note.tenantId === tenantId && note.corpus === corpus && !note.deletedAt && vaultPaths.includes(note.vaultPath)) {
          note.deletedAt = at
          store.chunks = store.chunks.filter((c) => c.noteId !== note.id)
          n++
        }
      }
      return n
    },

    async startRun(input: SyncRunStart) {
      if (store.outage) throw store.outage
      const row: VaultSyncRunRow = {
        id: nextId('run'),
        startedAt: input.startedAt,
        finishedAt: null,
        status: 'running',
        fromCommit: input.fromCommit,
        toCommit: null,
        notesScanned: 0,
        notesIndexed: 0,
        notesFailed: 0,
        failedPaths: [],
        error: null,
      }
      store.runs.push(row)
      return row.id
    },

    async finishRun(runId, patch: SyncRunFinish) {
      if (store.outage) throw store.outage
      const row = store.runs.find((r) => r.id === runId)
      if (!row) throw new Error(`unknown run ${runId}`)
      Object.assign(row, patch)
    },

    async getSyncStatus(tenantId, corpus, activeModel): Promise<VaultSyncStatus> {
      if (store.outage) throw store.outage
      const runs = [...store.runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      const live = [...notes.values()].filter((n) => n.tenantId === tenantId && n.corpus === corpus && !n.deletedAt)
      return {
        lastRun: runs[0] ?? null,
        lastSuccessfulRun: runs.find((r) => SUCCESSFUL_RUN_STATUSES.includes(r.status) && r.toCommit) ?? null,
        notesLive: live.length,
        notesOnActiveModel: live.filter((n) => n.embeddingModel === activeModel).length,
        chunksOnActiveModel: store.chunks.filter((c) => c.tenantId === tenantId && c.corpus === corpus && c.embeddingModel === activeModel).length,
      }
    },

    async searchChunks(params: SearchChunksParams): Promise<RawVaultHit[]> {
      if (store.outage) throw store.outage
      const hits: RawVaultHit[] = []
      for (const c of store.chunks) {
        if (c.tenantId !== params.tenantId || c.corpus !== params.corpus) continue
        if (c.embeddingModel !== params.embeddingModel) continue
        if (params.pathPrefix && !c.vaultPath.startsWith(params.pathPrefix)) continue
        const note = [...notes.values()].find((n) => n.id === c.noteId)
        if (!note || note.deletedAt) continue
        hits.push({
          vaultPath: c.vaultPath,
          noteTitle: note.noteTitle,
          headingPath: c.headingPath,
          charStart: c.charStart,
          charEnd: c.charEnd,
          content: c.content,
          similarity: cosine(params.queryEmbedding, c.embedding),
          contentSha: c.contentSha,
          indexedCommitSha: c.indexedCommitSha,
          sourceModifiedAt: note.sourceModifiedAt,
          indexedAt: c.indexedAt,
        })
      }
      return hits.sort((a, b) => b.similarity - a.similarity).slice(0, params.topK)
    },
  }
  return store
}
