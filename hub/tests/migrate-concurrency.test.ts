import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, afterAll } from 'vitest'
import postgres from 'postgres'
import { describeDb } from '../test/db-harness'

/* ════════════════════════════════════════════════════════════════════════════
   drizzle/migrate.mjs must be safe to run CONCURRENTLY against one database.

   `CREATE TABLE / INDEX / EXTENSION IF NOT EXISTS` is not concurrency-safe:
   two sessions that both pass the existence check race to insert the same
   catalog row and the loser fails with 23505 (pg_class_relname_nsp_index /
   pg_type_typname_nsp_index). vitest runs the migrator once per worker
   against a single fresh CI database, which is how CI on master went red on
   2026-09-22 ("Command failed: node drizzle/migrate.mjs" inside
   migrateTestDb). Two Cloud Run instances cold-starting together are the
   same race. The fix is a session-level advisory lock around the whole run.

   Two guards: a source assertion that the lock is in place (cheap, always
   runs), and a DB-backed reproduction that races several migrators against a
   brand-new database (runs where a test Postgres exists — CI's pgvector
   container — and skips locally without one).
   ════════════════════════════════════════════════════════════════════════════ */

const HUB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrate = readFileSync(path.join(HUB_DIR, 'drizzle', 'migrate.mjs'), 'utf8')

describe('drizzle/migrate.mjs — concurrent runs are serialized', () => {
  it('takes a session-level advisory lock before the first statement and releases it before disconnecting', () => {
    const lock = migrate.indexOf('pg_advisory_lock(${MIGRATE_LOCK_KEY})')
    const firstCreate = migrate.indexOf('CREATE EXTENSION IF NOT EXISTS vector')
    const unlock = migrate.indexOf('pg_advisory_unlock(${MIGRATE_LOCK_KEY})')
    const end = migrate.indexOf('await sql.end()')
    expect(lock).toBeGreaterThan(-1)
    expect(firstCreate).toBeGreaterThan(lock)
    expect(unlock).toBeGreaterThan(firstCreate)
    expect(end).toBeGreaterThan(unlock)
  })

  it('uses a lock key distinct from the test harness suite lock', () => {
    const migrateKey = /const MIGRATE_LOCK_KEY = (\d+)/.exec(migrate)?.[1]
    const harness = readFileSync(path.join(HUB_DIR, 'test', 'db-harness.ts'), 'utf8')
    const suiteKey = /const SUITE_LOCK_KEY = (\d+)/.exec(harness)?.[1]
    expect(migrateKey).toBeDefined()
    expect(suiteKey).toBeDefined()
    expect(migrateKey).not.toBe(suiteKey)
  })
})

function runMigrator(url: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile('node', ['drizzle/migrate.mjs'], { cwd: HUB_DIR, env: { ...process.env, DATABASE_URL: url } }, (err, _stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : err ? 1 : 0
      resolve({ code, stderr: String(stderr) })
    })
  })
}

describeDb('drizzle/migrate.mjs — race reproduction against a fresh database', () => {
  const baseUrl = process.env.DATABASE_URL as string
  const raceDb = `hub_migrate_race_${process.pid}`
  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} })

  afterAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${raceDb}`).catch(() => {})
    await admin.end({ timeout: 5 })
  })

  it('eight migrators started together against an empty database all succeed', async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${raceDb}`)
    await admin.unsafe(`CREATE DATABASE ${raceDb}`)
    const url = new URL(baseUrl)
    url.pathname = `/${raceDb}`

    const results = await Promise.all(Array.from({ length: 8 }, () => runMigrator(url.toString())))
    const failures = results.filter((r) => r.code !== 0)
    expect(failures.map((f) => f.stderr.trim().slice(-300))).toEqual([])

    // The database is fully migrated exactly once: the vault tables and the
    // pgvector-dependent chunk table all exist.
    const race = postgres(url.toString(), { max: 1, onnotice: () => {} })
    try {
      const tables = await race<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('tenants', 'document_chunks', 'vault_notes', 'vault_chunks', 'vault_sync_runs')`
      expect(tables.map((t) => t.table_name).sort()).toEqual(['document_chunks', 'tenants', 'vault_chunks', 'vault_notes', 'vault_sync_runs'])
    } finally {
      await race.end({ timeout: 5 })
    }
  }, 120_000)
})
