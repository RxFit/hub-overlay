import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * AntigravityHQ vault corpus (Lane 1) schema additions travel BOTH paths: the
 * production migration (drizzle/migrate.mjs, the deploy path) and the generated
 * SQL ledger file — kept narrowly ADDITIVE. The guard mirrors
 * needs-you-migration.test.ts: no statement here may touch document_chunks or
 * any other existing table.
 */
describe('vault search migration (vault_notes + vault_chunks + vault_sync_runs)', () => {
  const migrate = readFileSync(new URL('../drizzle/migrate.mjs', import.meta.url), 'utf8')
  const generated = readFileSync(new URL('../drizzle/0013_vault_search.sql', import.meta.url), 'utf8')

  it('creates vault_notes with the (tenant, corpus, path) uniqueness and the tombstone column', () => {
    expect(migrate).toMatch(/CREATE TABLE IF NOT EXISTS vault_notes[\s\S]*content_sha\s+TEXT NOT NULL[\s\S]*deleted_at\s+TIMESTAMPTZ/)
    expect(migrate).toMatch(/vault_notes_tenant_corpus_path_uniq[\s\S]*\(tenant_id, corpus, vault_path\)/)
  })

  it('creates vault_chunks with a VECTOR(768) column and an HNSW cosine index, inside the pgvector guard', () => {
    expect(migrate).toMatch(/CREATE TABLE IF NOT EXISTS vault_chunks[\s\S]*embedding\s+VECTOR\(768\)/)
    expect(migrate).toMatch(/vault_chunks_embedding_hnsw_idx[\s\S]*USING hnsw \(embedding vector_cosine_ops\)/)
    // The chunk table depends on the extension, so it must sit under the same
    // non-fatal `vectorOk` branch document_chunks uses — never unconditionally.
    const guarded = migrate.indexOf('if (vectorOk) {', migrate.indexOf('vault_sync_runs table'))
    const chunks = migrate.indexOf('CREATE TABLE IF NOT EXISTS vault_chunks')
    expect(guarded).toBeGreaterThan(-1)
    expect(chunks).toBeGreaterThan(guarded)
    expect(migrate).toMatch(/note_id\s+UUID NOT NULL REFERENCES vault_notes\(id\) ON DELETE CASCADE/)
  })

  it('creates the vault_sync_runs ledger with per-run counters and failed_paths', () => {
    expect(migrate).toMatch(/CREATE TABLE IF NOT EXISTS vault_sync_runs[\s\S]*notes_scanned\s+INTEGER NOT NULL DEFAULT 0[\s\S]*failed_paths\s+JSONB/)
    expect(migrate).toMatch(/vault_sync_runs_started_idx[\s\S]*\(tenant_id, corpus, started_at DESC\)/)
  })

  it('keeps the generated migration narrowly additive and away from existing tables', () => {
    expect(generated).toContain('CREATE TABLE IF NOT EXISTS "vault_notes"')
    expect(generated).toContain('CREATE TABLE IF NOT EXISTS "vault_chunks"')
    expect(generated).toContain('CREATE TABLE IF NOT EXISTS "vault_sync_runs"')
    expect(generated).toContain('"embedding" vector(768)')
    expect(generated).not.toMatch(/DROP|ALTER COLUMN|SET NOT NULL/)
    // Only the three new tables are ever named after ALTER TABLE.
    const altered = [...generated.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1])
    expect(new Set(altered)).toEqual(new Set(['vault_notes', 'vault_chunks', 'vault_sync_runs']))
    expect(generated).not.toContain('document_chunks')
  })

  it('never touches document_chunks in the production path either', () => {
    const start = migrate.indexOf('AntigravityHQ vault corpus')
    const end = migrate.indexOf("INSERT INTO tenants (id, name, domain)", start)
    const block = migrate.slice(start, end)
    expect(block.length).toBeGreaterThan(500)
    expect(block).not.toMatch(/(?:TABLE|ON|INTO|FROM|ALTER)\s+document_chunks/)
    expect(block).not.toMatch(/DROP|ALTER TABLE/)
  })
})
