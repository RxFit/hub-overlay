/**
 * Disposable-Postgres test harness (NS-3).
 *
 * Lets route/repository tests run against a REAL Postgres instead of only
 * asserting early-exit (401/403/400) branches. The primary path is the CI
 * `services: postgres` container (see .github/workflows/ci.yml), which exposes
 * a test-scoped `DATABASE_URL` (e.g. postgres://postgres:postgres@localhost:5432/hub_test).
 *
 * Local runs WITHOUT a `DATABASE_URL` skip DB-backed tests entirely — see
 * `dbAvailable` / `describeDb` below — so `npm test` stays green with no
 * Postgres present. DB tests only execute where a DB is provisioned (CI).
 *
 * Contract:
 *   - `dbAvailable`            — true when a test DB is reachable (gate).
 *   - `describeDb`             — describe.skipIf(!dbAvailable) sugar.
 *   - `migrateTestDb()`        — run the drizzle migrations once per process.
 *   - `resetDb()`             — truncate app tables + restore the base seed.
 *   - `withCleanDb(fn)`        — reset, then run `fn` against a clean DB.
 *   - `seedTenant()` / `seedKpi()` — minimal fixture helpers.
 *   - `getSql()`               — the raw `postgres` client for assertions.
 *
 * NEVER point this at a real/prod database — only the ephemeral CI service.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { describe } from 'vitest'

const HUB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** True when DB-backed tests should run (a test DB connection string is set). */
export const dbAvailable: boolean = Boolean(
  process.env.DATABASE_URL || process.env.RUN_DB_TESTS,
)

/**
 * `describe` that runs only when a test DB is present, and cleanly SKIPS
 * locally when it is not. Use this for every DB-backed suite.
 */
export const describeDb = describe.skipIf(!dbAvailable)

/** Tables the harness owns/resets between tests. Order is not significant
 *  because we TRUNCATE with CASCADE, but `tenants` is re-seeded afterwards. */
const RESET_TABLES = [
  'kpis',
  'ai_action_log',
  'event_log',
  'hub_users',
  'agent_memory',
  'hub_secrets',
] as const

let _sql: ReturnType<typeof postgres> | null = null
let _migrated = false

function requireUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      '[db-harness] DATABASE_URL is not set. DB-backed tests must be gated ' +
        'with describeDb / dbAvailable so they skip when no test DB exists.',
    )
  }
  return url
}

/** Lazily-created singleton `postgres` client for the test DB. */
export function getSql(): ReturnType<typeof postgres> {
  if (_sql) return _sql
  _sql = postgres(requireUrl(), { max: 1, onnotice: () => {} })
  return _sql
}

/**
 * Run the drizzle migrations against the test DB exactly once per process.
 * Reuses `drizzle/migrate.mjs` verbatim (idempotent `CREATE ... IF NOT EXISTS`)
 * so the test schema is always identical to what the deploy runner applies.
 */
export function migrateTestDb(): void {
  if (_migrated) return
  const url = requireUrl()
  execFileSync('node', ['drizzle/migrate.mjs'], {
    cwd: HUB_DIR,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'ignore',
  })
  _migrated = true
}

/** Ensure the default `rxfit` tenant exists (matches migrate.mjs seed). */
export async function seedTenant(
  id = 'rxfit',
  name = 'RxFit Athletics',
  domain = 'rxfitatx.com',
): Promise<void> {
  const sql = getSql()
  await sql`
    INSERT INTO tenants (id, name, domain)
    VALUES (${id}, ${name}, ${domain})
    ON CONFLICT (id) DO NOTHING
  `
}

/** Insert a KPI row and return its id. Minimal fixture for route tests. */
export async function seedKpi(input: {
  tenantId?: string
  label: string
  value?: string
  visibility?: string
  scope?: string
  trend?: string | null
  trendDirection?: string
}): Promise<string> {
  const sql = getSql()
  const rows = await sql<{ id: string }[]>`
    INSERT INTO kpis (tenant_id, label, value, visibility, scope, trend, trend_direction)
    VALUES (
      ${input.tenantId ?? 'rxfit'},
      ${input.label},
      ${input.value ?? '0'},
      ${input.visibility ?? 'staff'},
      ${input.scope ?? 'global'},
      ${input.trend ?? null},
      ${input.trendDirection ?? 'neutral'}
    )
    RETURNING id
  `
  return rows[0].id
}

/**
 * Insert one `ai_action_log` row directly (bypassing the redaction mapper) and
 * return its id. An explicit `createdAt` makes newest-first ordering tests
 * deterministic — rows inserted in the same millisecond would otherwise tie.
 */
export async function seedAiAction(input: {
  userEmail: string
  actionType?: string
  actor?: string
  status?: string
  intent?: string | null
  requestId?: string | null
  target?: Record<string, unknown> | null
  error?: string | null
  createdAt?: Date
}): Promise<string> {
  const sql = getSql()
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ai_action_log (user_email, actor, action_type, target, intent, request_id, status, error, created_at)
    VALUES (
      ${input.userEmail.toLowerCase().trim()},
      ${input.actor ?? 'ai'},
      ${input.actionType ?? 'gmail_send'},
      ${input.target ? JSON.stringify(input.target) : null},
      ${input.intent ?? null},
      ${input.requestId ?? null},
      ${input.status ?? 'success'},
      ${input.error ?? null},
      ${input.createdAt ?? new Date()}
    )
    RETURNING id
  `
  return rows[0].id
}

/**
 * Insert one `event_log` row directly — used to seed persisted telemetry
 * (`telemetry:*` rows, NS-10) without going through the observability sink.
 * An explicit `createdAt` makes window-filtering tests deterministic.
 */
export async function seedTelemetryEvent(input: {
  eventType: string
  payload?: Record<string, unknown> | null
  actor?: string
  correlationId?: string | null
  tenantId?: string
  createdAt?: Date
}): Promise<void> {
  const sql = getSql()
  await sql`
    INSERT INTO event_log (tenant_id, event_type, actor, payload, correlation_id, created_at)
    VALUES (
      ${input.tenantId ?? 'rxfit'},
      ${input.eventType},
      ${input.actor ?? 'system'},
      ${input.payload ? JSON.stringify(input.payload) : null},
      ${input.correlationId ?? null},
      ${input.createdAt ?? new Date()}
    )
  `
}

/* Vitest runs test FILES in parallel workers, but they all share the single
 * test database — one suite's TRUNCATE would race another suite's inserts.
 * A session-level advisory lock serializes DB-backed suites: the first
 * `resetDb()` in a worker takes the lock and holds it until `closeDb()`
 * (or worker exit) releases it, so suites run one at a time while pure
 * suites stay fully parallel. */
const SUITE_LOCK_KEY = 727272
let _suiteLocked = false

async function acquireSuiteLock(): Promise<void> {
  if (_suiteLocked) return
  await getSql()`SELECT pg_advisory_lock(${SUITE_LOCK_KEY})`
  _suiteLocked = true
}

/**
 * Truncate the harness-owned tables and restore the base seed so each test
 * starts from a deterministic, empty-but-seeded state (no flakiness).
 */
export async function resetDb(): Promise<void> {
  await acquireSuiteLock()
  const sql = getSql()
  await sql.unsafe(
    `TRUNCATE TABLE ${RESET_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
  )
  await seedTenant()
}

/** Reset to a clean DB, then run `fn`. */
export async function withCleanDb<T>(fn: () => Promise<T>): Promise<T> {
  await resetDb()
  return fn()
}

/** Close the shared client (releasing the suite lock). Call from an afterAll
 *  if a suite needs teardown. */
export async function closeDb(): Promise<void> {
  if (_sql) {
    if (_suiteLocked) {
      await _sql`SELECT pg_advisory_unlock(${SUITE_LOCK_KEY})`.catch(() => {})
      _suiteLocked = false
    }
    await _sql.end({ timeout: 5 })
    _sql = null
  }
}
