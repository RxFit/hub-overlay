import { it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { describeDb, migrateTestDb, seedTenant, getSql, closeDb } from '../test/db-harness'

/* ════════════════════════════════════════════════════════════════════════════
   upsertDocumentChunk idempotency (P2) — DB-backed.

   The function was INSERT-only despite its name, so re-ingesting the same
   (tenantId, sourceUrl, content) accumulated duplicate chunks that all surface
   in search. The fix deletes any identical prior chunk before inserting, in one
   transaction — WITHOUT wiping sibling chunks (a document is many chunks under
   one sourceUrl). Gated with describeDb: runs in CI (real Postgres), skips
   locally. The embedding model is mocked so no live API/key is needed.
   ════════════════════════════════════════════════════════════════════════════ */

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return {
        embedContent: async () => ({ embedding: { values: new Array(768).fill(0.01) } }),
      }
    }
  },
}))

// getGenAI() reads a key before constructing (even the mocked client).
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key'

import { upsertDocumentChunk } from '@/lib/vector-store'

const TENANT = 'rxfit'
const URL_A = 'https://docs.google.com/document/d/abc123/edit'

async function countChunks(sourceUrl: string, content?: string): Promise<number> {
  const sql = getSql()
  const rows =
    content === undefined
      ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_chunks WHERE tenant_id = ${TENANT} AND source_url = ${sourceUrl}`
      : await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_chunks WHERE tenant_id = ${TENANT} AND source_url = ${sourceUrl} AND content = ${content}`
  return rows[0].n
}

describeDb('upsertDocumentChunk — idempotent re-ingest', () => {
  beforeAll(() => {
    migrateTestDb()
  })

  beforeEach(async () => {
    await seedTenant()
    await getSql()`DELETE FROM document_chunks WHERE tenant_id = ${TENANT}`
  })

  afterAll(async () => {
    await closeDb()
  })

  it('re-ingesting an identical chunk does not create a duplicate', async () => {
    await upsertDocumentChunk(TENANT, URL_A, 'chunk one')
    await upsertDocumentChunk(TENANT, URL_A, 'chunk one')
    expect(await countChunks(URL_A, 'chunk one')).toBe(1)
    expect(await countChunks(URL_A)).toBe(1)
  })

  it('preserves sibling chunks of the same document (different content)', async () => {
    await upsertDocumentChunk(TENANT, URL_A, 'chunk one')
    await upsertDocumentChunk(TENANT, URL_A, 'chunk two')
    // Re-ingest chunk one — must not wipe chunk two.
    await upsertDocumentChunk(TENANT, URL_A, 'chunk one')
    expect(await countChunks(URL_A)).toBe(2)
    expect(await countChunks(URL_A, 'chunk one')).toBe(1)
    expect(await countChunks(URL_A, 'chunk two')).toBe(1)
  })

  it('first ingest inserts one row (unchanged behaviour)', async () => {
    const row = await upsertDocumentChunk(TENANT, URL_A, 'fresh')
    expect(row?.id).toBeTruthy()
    expect(await countChunks(URL_A)).toBe(1)
  })
})
