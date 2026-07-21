import { it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { describeDb, migrateTestDb, seedTenant, getSql, closeDb } from '../test/db-harness'

/* ════════════════════════════════════════════════════════════════════════════
   searchSimilarDocuments model-scoping (embedding-space safety) — DB-backed.

   gemini-embedding-001 (EOL 2026-07-14) and gemini-embedding-2 produce vectors
   in INCOMPATIBLE spaces. A stored embedding is only comparable to a query
   vector from the SAME model, so search must return ONLY rows tagged with the
   active EMBEDDING_MODEL. A row on a stale model — even an identical vector that
   would score a perfect cosine match — must be excluded, else a cross-space
   comparison leaks a meaningless "match". Legacy NULL-model rows (pre-migration)
   are excluded for the same reason, until the backfill re-embeds them.

   Gated with describeDb: runs in CI (real Postgres), skips locally. The embedding
   model is mocked so no live API/key is needed; all three rows share an identical
   vector so the ONLY thing that can exclude two of them is the model filter.
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

import { searchSimilarDocuments, EMBEDDING_MODEL } from '@/lib/vector-store'

// Own tenant so this suite's document_chunks rows can't race the parallel
// upsert-idempotency suite (both mutate document_chunks; the harness resets
// neither this table nor `tenants`, and DB suites run in parallel workers).
const TENANT = 'tkg-embedding-scope'
const VEC = `[${new Array(768).fill(0.01).join(',')}]`

describeDb('searchSimilarDocuments — active-model scoping', () => {
  beforeAll(() => {
    migrateTestDb()
  })

  beforeEach(async () => {
    await seedTenant(TENANT, 'TKG Embedding Scope Test', 'example.com')
    await getSql()`DELETE FROM document_chunks WHERE tenant_id = ${TENANT}`
  })

  afterAll(async () => {
    await closeDb()
  })

  it('returns only rows produced by the active model; excludes stale-model and legacy NULL rows', async () => {
    const sql = getSql()
    // Active-model row: identical vector, current model → must be returned.
    await sql`INSERT INTO document_chunks (tenant_id, source_url, content, embedding, embedding_model)
              VALUES (${TENANT}, 'active://doc', 'current model chunk', ${VEC}::vector, ${EMBEDDING_MODEL})`
    // Stale-model row: identical vector, EOL model → must be excluded.
    await sql`INSERT INTO document_chunks (tenant_id, source_url, content, embedding, embedding_model)
              VALUES (${TENANT}, 'stale://doc', 'old model chunk', ${VEC}::vector, 'gemini-embedding-001')`
    // Legacy pre-migration row: identical vector, NULL model → must be excluded.
    await sql`INSERT INTO document_chunks (tenant_id, source_url, content, embedding, embedding_model)
              VALUES (${TENANT}, 'legacy://doc', 'legacy chunk', ${VEC}::vector, NULL)`

    const results = await searchSimilarDocuments(TENANT, 'any query', 10)
    const urls = results.map((r) => r.sourceUrl)

    expect(urls).toContain('active://doc')
    expect(urls).not.toContain('stale://doc')
    expect(urls).not.toContain('legacy://doc')
    expect(results).toHaveLength(1)
  })
})
