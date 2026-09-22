import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describeDb } from '../test/db-harness'

/**
 * Guard: concurrent runs of drizzle/migrate.mjs must all succeed.
 *
 * WHY THIS EXISTS — a race in the migration runner turned master red and
 * skipped a deploy. Every vitest worker process runs `node drizzle/migrate.mjs`
 * at its own start against the same CI Postgres, and the runner rebuilds two
 * tool_runs indexes with drop-if-exists followed by a plain create. Two
 * sessions doing that at once collide in the catalog: on 2026-09-22 (CI run
 * 35677400752) the loser died with `duplicate key value violates unique
 * constraint "pg_class_relname_nsp_index"` for tool_runs_user_created_idx, the
 * harness threw "Command failed: node drizzle/migrate.mjs" with its stderr
 * discarded, tests/feed-ai-db.test.ts failed, and deploy.yml — gated on a
 * green CI — skipped. The identical tree had passed on the PR minutes earlier.
 * The same runner executes at every Cloud Run cold start (docker-entrypoint.sh),
 * where several instances can start together, so this is not only a CI concern.
 *
 * The fix is a session-level advisory lock taken before any DDL. This file pins
 * it two ways: statically (the lock precedes the first statement in run()) and,
 * where a test DB exists, by racing several migrators and requiring every one
 * to exit 0 — a pass that is deterministic with the lock and only flaky-lucky
 * without it.
 */

const hubRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const MIGRATE = join(hubRoot, 'drizzle', 'migrate.mjs')
const execFileP = promisify(execFile)

/** The runner's source with comments removed, so prose cannot satisfy or defeat the scan. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('drizzle/migrate.mjs — concurrent migrators (static)', () => {
  const code = codeOnly(readFileSync(MIGRATE, 'utf8'))
  const runBody = code.slice(code.indexOf('async function run()'))

  it('takes a Postgres advisory lock before the first statement that changes the schema', () => {
    expect(runBody).toContain('async function run()')
    const lockAt = runBody.search(/acquireMigrationLock\(\)/)
    const firstStatement = runBody.search(/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/)
    expect(lockAt).toBeGreaterThan(-1)
    expect(firstStatement).toBeGreaterThan(-1)
    expect(lockAt).toBeLessThan(firstStatement)
    expect(code).toMatch(/pg_advisory_lock\(\$\{MIGRATE_LOCK_KEY\}::bigint\)/)
    expect(code).toMatch(/pg_try_advisory_lock\(\$\{MIGRATE_LOCK_KEY\}::bigint\)/)
  })

  it('holds the lock on a single connection for the whole run (max: 1, released by sql.end())', () => {
    expect(code).toMatch(/postgres\(cleanUrl,\s*\{\s*max:\s*1\b/)
    expect(runBody).toContain('await sql.end()')
  })
})

describeDb('drizzle/migrate.mjs — concurrent migrators (DB-backed)', () => {
  it('several migrators started at the same moment all exit 0', async () => {
    const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL }
    const attempts = Array.from({ length: 3 }, () =>
      execFileP('node', ['drizzle/migrate.mjs'], { cwd: hubRoot, env, timeout: 100_000 }),
    )
    const results = await Promise.allSettled(attempts)
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as { stderr?: string; message?: string }] : []))
    expect(failures.map((f) => `${f.message ?? ''}\n${f.stderr ?? ''}`)).toEqual([])
    for (const r of results) {
      if (r.status === 'fulfilled') expect(r.value.stdout).toContain('[migrate] ✅ Done')
    }
  }, 120_000)
})
