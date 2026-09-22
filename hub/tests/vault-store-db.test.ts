import { it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { describeDb, migrateTestDb, seedTenant, getSql, closeDb, lockSuite } from '../test/db-harness'
import { createDrizzleVaultStore } from '@/lib/vault/store'

/* ════════════════════════════════════════════════════════════════════════════
   Drizzle VaultStore against a REAL Postgres + pgvector — the contracts the
   memory store mirrors, proven on the production persistence path:
     - the migration creates the three tables (via drizzle/migrate.mjs)
     - promoteNote is one transaction: upsert + replace chunks, idempotent on
       the (tenant, corpus, path) key, and a failing insert rolls back the
       delete of the previous chunk set
     - tombstoneNotes keeps the row, drops the chunks
     - searchChunks returns only ACTIVE-model rows on live notes, ordered by
       cosine similarity, honoring pathPrefix and topK
     - getSyncStatus reads the ledger + coverage counts

   Gated with describeDb: runs in CI (pgvector service container) and locally
   only when DATABASE_URL points at a throwaway instance.
   ════════════════════════════════════════════════════════════════════════════ */

const TENANT = 'tkg-vault-store'
const CORPUS = 'antigravityhq'
const MODEL = 'gemini-embedding-2'

function vec(seed: number): number[] {
  // Two distinguishable unit-ish vectors: seed steers the first component.
  const v = new Array(768).fill(0.01)
  v[0] = seed
  return v
}

describeDb('Drizzle VaultStore (Postgres + pgvector)', () => {
  const store = createDrizzleVaultStore()

  beforeAll(() => {
    migrateTestDb()
  })

  beforeEach(async () => {
    await lockSuite()
    await seedTenant(TENANT, 'Vault Store Test', 'example.com')
    const sql = getSql()
    await sql`DELETE FROM vault_chunks WHERE tenant_id = ${TENANT}`
    await sql`DELETE FROM vault_notes WHERE tenant_id = ${TENANT}`
    await sql`DELETE FROM vault_sync_runs WHERE tenant_id = ${TENANT}`
  })

  afterAll(async () => {
    await closeDb()
  })

  const promote = (path: string, texts: string[], opts: Partial<{ sha: string; model: string; commit: string; seed: number }> = {}) =>
    store.promoteNote({
      tenantId: TENANT,
      corpus: CORPUS,
      vaultPath: path,
      noteTitle: path,
      frontmatter: { tags: ['t'] },
      contentSha: opts.sha ?? `sha-${path}`,
      indexedCommitSha: opts.commit ?? 'commit-1',
      embeddingModel: opts.model ?? MODEL,
      sourceModifiedAt: new Date('2026-09-19T00:00:00Z'),
      indexedAt: new Date(),
      chunks: texts.map((t, i) => ({ headingPath: `H${i}`, charStart: i * 10, charEnd: i * 10 + t.length, content: t, embedding: vec(opts.seed ?? 0.5) })),
    })

  it('the migration created the vault tables and the HNSW index', async () => {
    const sql = getSql()
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_name IN ('vault_notes', 'vault_chunks', 'vault_sync_runs')`
    expect(tables.map((t) => t.table_name).sort()).toEqual(['vault_chunks', 'vault_notes', 'vault_sync_runs'])
    const idx = await sql<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'vault_chunks'`
    expect(idx.map((i) => i.indexname)).toContain('vault_chunks_embedding_hnsw_idx')
  })

  it('promoteNote upserts on (tenant, corpus, path) and replaces the chunk set atomically', async () => {
    await promote('Projects/A.md', ['one', 'two', 'three'])
    let index = await store.listNoteIndex(TENANT, CORPUS)
    expect(index).toHaveLength(1)
    const idBefore = index[0].id
    expect(index[0]).toMatchObject({ vaultPath: 'Projects/A.md', contentSha: 'sha-Projects/A.md', embeddingModel: MODEL, deletedAt: null })

    await promote('Projects/A.md', ['uno'], { sha: 'sha-2', commit: 'commit-2' })
    index = await store.listNoteIndex(TENANT, CORPUS)
    expect(index).toHaveLength(1)
    expect(index[0].id).toBe(idBefore) // same row, updated in place
    expect(index[0].contentSha).toBe('sha-2')
    const chunks = await getSql()<{ content: string; indexed_commit_sha: string }[]>`SELECT content, indexed_commit_sha FROM vault_chunks WHERE tenant_id = ${TENANT}`
    expect(chunks).toEqual([{ content: 'uno', indexed_commit_sha: 'commit-2' }])
  })

  it('a failure inside the promotion transaction rolls back — the previous chunks survive', async () => {
    await promote('Projects/B.md', ['keep me', 'and me'])
    // A 3-dim vector into a vector(768) column fails the INSERT after the DELETE ran in the same tx.
    await expect(
      store.promoteNote({
        tenantId: TENANT,
        corpus: CORPUS,
        vaultPath: 'Projects/B.md',
        noteTitle: 'B',
        frontmatter: {},
        contentSha: 'sha-new',
        indexedCommitSha: 'commit-9',
        embeddingModel: MODEL,
        sourceModifiedAt: null,
        indexedAt: new Date(),
        chunks: [{ headingPath: '', charStart: 0, charEnd: 3, content: 'bad', embedding: [1, 2, 3] }],
      }),
    ).rejects.toBeTruthy()
    const rows = await getSql()<{ content: string }[]>`SELECT content FROM vault_chunks WHERE vault_path = 'Projects/B.md' AND tenant_id = ${TENANT} ORDER BY char_start`
    expect(rows.map((r) => r.content)).toEqual(['keep me', 'and me'])
    const [note] = await store.listNoteIndex(TENANT, CORPUS)
    expect(note.contentSha).toBe('sha-Projects/B.md') // the note row update rolled back too
  })

  it('tombstoneNotes keeps the row with deleted_at and drops its chunks; a re-promote clears the tombstone', async () => {
    await promote('Projects/C.md', ['c1', 'c2'])
    await promote('Projects/D.md', ['d1'])
    const n = await store.tombstoneNotes(TENANT, CORPUS, ['Projects/C.md', 'Projects/Nope.md'], new Date())
    expect(n).toBe(1)
    const index = await store.listNoteIndex(TENANT, CORPUS)
    expect(index.find((r) => r.vaultPath === 'Projects/C.md')?.deletedAt).toBeInstanceOf(Date)
    expect(index.find((r) => r.vaultPath === 'Projects/D.md')?.deletedAt).toBeNull()
    const chunks = await getSql()<{ vault_path: string }[]>`SELECT vault_path FROM vault_chunks WHERE tenant_id = ${TENANT}`
    expect(chunks.map((c) => c.vault_path)).toEqual(['Projects/D.md'])
    // Tombstoning again is a no-op (already deleted).
    expect(await store.tombstoneNotes(TENANT, CORPUS, ['Projects/C.md'], new Date())).toBe(0)

    await promote('Projects/C.md', ['back'])
    expect((await store.listNoteIndex(TENANT, CORPUS)).find((r) => r.vaultPath === 'Projects/C.md')?.deletedAt).toBeNull()
  })

  it('searchChunks: active model only, live notes only, cosine order, pathPrefix, topK', async () => {
    await promote('Projects/Near.md', ['near'], { seed: 0.9 })
    await promote('Projects/Far.md', ['far'], { seed: -0.9 })
    await promote('Projects/Stale.md', ['stale'], { seed: 0.9, model: 'gemini-embedding-001' })
    await promote('Daily/Gone.md', ['gone'], { seed: 0.9 })
    await promote('Daily/Other.md', ['other'], { seed: 0.9 })
    await store.tombstoneNotes(TENANT, CORPUS, ['Daily/Gone.md'], new Date())

    const hits = await store.searchChunks({ tenantId: TENANT, corpus: CORPUS, embeddingModel: MODEL, queryEmbedding: vec(0.9), topK: 10 })
    expect(hits.map((h) => h.vaultPath)).toEqual(['Projects/Near.md', 'Daily/Other.md', 'Projects/Far.md'])
    expect(hits[0].similarity).toBeGreaterThan(hits[2].similarity)
    expect(hits[0]).toMatchObject({ noteTitle: 'Projects/Near.md', headingPath: 'H0', charStart: 0, charEnd: 4, content: 'near', contentSha: 'sha-Projects/Near.md', indexedCommitSha: 'commit-1' })
    expect(hits[0].indexedAt).toBeInstanceOf(Date)
    expect(hits[0].sourceModifiedAt?.toISOString()).toBe('2026-09-19T00:00:00.000Z')

    const scoped = await store.searchChunks({ tenantId: TENANT, corpus: CORPUS, embeddingModel: MODEL, queryEmbedding: vec(0.9), topK: 10, pathPrefix: 'Projects/' })
    expect(scoped.map((h) => h.vaultPath)).toEqual(['Projects/Near.md', 'Projects/Far.md'])

    const one = await store.searchChunks({ tenantId: TENANT, corpus: CORPUS, embeddingModel: MODEL, queryEmbedding: vec(0.9), topK: 1 })
    expect(one).toHaveLength(1)

    const otherTenant = await store.searchChunks({ tenantId: 'rxfit', corpus: CORPUS, embeddingModel: MODEL, queryEmbedding: vec(0.9), topK: 10 })
    expect(otherTenant.filter((h) => h.vaultPath.startsWith('Projects/Near'))).toEqual([])
  })

  it('startRun/finishRun/getSyncStatus: ledger + coverage counts', async () => {
    await promote('Projects/E.md', ['e1', 'e2'])
    await promote('Projects/F.md', ['f1'], { model: 'gemini-embedding-001' })
    let status = await store.getSyncStatus(TENANT, CORPUS, MODEL)
    expect(status.lastRun).toBeNull()
    expect(status).toMatchObject({ notesLive: 2, notesOnActiveModel: 1, chunksOnActiveModel: 2 })

    const failedId = await store.startRun({ tenantId: TENANT, corpus: CORPUS, startedAt: new Date(Date.now() - 20_000), fromCommit: null })
    await store.finishRun(failedId, { finishedAt: new Date(Date.now() - 19_000), status: 'failed', toCommit: null, notesScanned: 0, notesIndexed: 0, notesFailed: 0, failedPaths: [], error: 'HTTP 401' })
    const okId = await store.startRun({ tenantId: TENANT, corpus: CORPUS, startedAt: new Date(Date.now() - 10_000), fromCommit: null })
    await store.finishRun(okId, { finishedAt: new Date(Date.now() - 9_000), status: 'completed_with_failures', toCommit: 'abc', notesScanned: 3, notesIndexed: 2, notesFailed: 1, failedPaths: [{ path: 'x.md', message: 'boom' }], error: null })
    const runningId = await store.startRun({ tenantId: TENANT, corpus: CORPUS, startedAt: new Date(), fromCommit: 'abc' })

    status = await store.getSyncStatus(TENANT, CORPUS, MODEL)
    expect(status.lastRun?.id).toBe(runningId)
    expect(status.lastRun?.status).toBe('running')
    expect(status.lastSuccessfulRun?.id).toBe(okId)
    expect(status.lastSuccessfulRun).toMatchObject({ toCommit: 'abc', notesScanned: 3, notesFailed: 1, failedPaths: [{ path: 'x.md', message: 'boom' }] })
    expect(status.lastSuccessfulRun?.finishedAt).toBeInstanceOf(Date)
  })
})
