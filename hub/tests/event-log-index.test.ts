import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeDb, migrateTestDb, getSql, closeDb } from '../test/db-harness'

/* ════════════════════════════════════════════════════════════════════════════
   event_log (event_type, created_at) index (P2 perf).

   The append-only event_log had no index, so the ai-health read
   (WHERE event_type LIKE 'telemetry:%' AND created_at >= …) and the retention
   prune (WHERE tenant_id AND created_at < cutoff) seq-scanned. We add a
   composite index in the Drizzle schema AND idempotently in migrate.mjs. The
   static checks run everywhere; the DB-backed check confirms it materializes.
   ════════════════════════════════════════════════════════════════════════════ */

const HUB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('event_log index — source of truth', () => {
  it('migrate.mjs creates the index idempotently', () => {
    const migrate = readFileSync(path.join(HUB_DIR, 'drizzle/migrate.mjs'), 'utf8')
    expect(migrate).toMatch(/CREATE INDEX IF NOT EXISTS\s+event_log_type_created_idx/)
    expect(migrate).toMatch(/ON event_log \(event_type, created_at\)/)
  })

  it('the Drizzle schema declares the composite index', () => {
    const schema = readFileSync(path.join(HUB_DIR, 'lib/schema.ts'), 'utf8')
    expect(schema).toMatch(/index\('event_log_type_created_idx'\)\.on\(t\.eventType, t\.createdAt\)/)
  })
})

describeDb('event_log index — DB-backed', () => {
  beforeAll(() => {
    migrateTestDb()
  })
  afterAll(async () => {
    await closeDb()
  })

  it('the index exists after migrate', async () => {
    const sql = getSql()
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'event_log' AND indexname = 'event_log_type_created_idx'
    `
    expect(rows).toHaveLength(1)
  })
})
