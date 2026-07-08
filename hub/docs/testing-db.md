# DB-backed tests (test-Postgres harness)

Most route tests only exercise the early-exit guards (`401` / `403` / `400`)
that return **before** any database access, so they need no DB. When you need to
assert real query/insert/update behavior, use the disposable-Postgres harness in
[`hub/test/db-harness.ts`](../test/db-harness.ts).

The exemplar is
[`tests/settings-kpis-db.test.ts`](../tests/settings-kpis-db.test.ts) — copy it.

## How it runs

- **In CI** the "Typecheck & test" job starts an ephemeral `pgvector/pgvector:pg16`
  service container (health-waited) and sets
  `DATABASE_URL=postgres://postgres:postgres@localhost:5432/hub_test`. DB-backed
  suites run there.
- **Locally**, with no `DATABASE_URL`, DB-backed suites **skip cleanly** — so
  `npm test` stays green with no Postgres installed.

The harness runs the same `drizzle/migrate.mjs` the deploy path uses (idempotent
`CREATE ... IF NOT EXISTS`), so the test schema is always identical to prod.

> Never point `DATABASE_URL` at a real/prod database when running tests — only an
> ephemeral, throwaway instance.

## Running DB tests locally (optional)

Spin up a throwaway Postgres with pgvector and point the suite at it:

```bash
docker run -d --name hub-test-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=hub_test \
  -p 5432:5432 pgvector/pgvector:pg16

DATABASE_URL="postgres://postgres:postgres@localhost:5432/hub_test" npm test
```

## Writing a DB-backed test

```ts
import { it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { describeDb, migrateTestDb, resetDb, seedKpi, getSql, closeDb } from '../test/db-harness'

// describeDb === describe.skipIf(!dbAvailable): the whole suite skips with no DB.
describeDb('my repository/route — DB-backed', () => {
  beforeAll(() => { migrateTestDb() })   // migrate once per process
  beforeEach(async () => { await resetDb() }) // truncate + re-seed base tenant
  afterAll(async () => { await closeDb() })

  it('persists a row', async () => {
    await seedKpi({ label: 'Revenue', visibility: 'staff' })
    const rows = await getSql()`SELECT count(*)::int AS n FROM kpis`
    expect(rows[0].n).toBe(1)
  })
})
```

### Harness API

| Export | Purpose |
| --- | --- |
| `dbAvailable` | `true` when a test DB is reachable (`DATABASE_URL` or `RUN_DB_TESTS` set). |
| `describeDb` | `describe.skipIf(!dbAvailable)` — gate every DB-backed suite with this. |
| `migrateTestDb()` | Runs `drizzle/migrate.mjs` once per process against the test DB. |
| `resetDb()` | `TRUNCATE ... RESTART IDENTITY CASCADE` on owned tables, then restores the `rxfit` tenant seed. Call in `beforeEach` for determinism. |
| `withCleanDb(fn)` | `resetDb()` then run `fn` against the clean DB. |
| `seedTenant()` / `seedKpi()` | Minimal fixture helpers. |
| `getSql()` | The raw `postgres` client for direct assertions. |
| `closeDb()` | Close the shared client (use in `afterAll`). |

## Coverage scope & ratchet (NS-8 / NS-11)

`npm run test:coverage` enforces ratcheting floors in
[`vitest.config.ts`](../vitest.config.ts). What is measured (NS-11):

- **Included:** `lib/**`, `app/api/**`, and `app/hooks/**` (hooks were added in
  NS-11 once the NS-5–NS-7 hook suites made them genuinely tested territory).
- **Excluded:** test files, `lib/schema.ts` (generated shapes),
  `app/hooks/query-test-utils.ts` (test infrastructure), and exactly one product
  file — `app/hooks/useChatEngine.ts`, the streaming chat engine (SSE/DOM/abort
  plumbing, exercised by the Playwright e2e flows; unit-hostile). It is the only
  documented exclusion; remove it if the engine ever grows a unit seam.
- **Floors (as of NS-11):** lines/statements **45**, branches **79**, functions
  **67** — set ~2 points under the measured **local, DB-skipped** run
  (47.00 / 81.14 / 69.29), which is the binding lower bound: CI runs the DB
  suites too and always measures higher. Never lower a floor; raise them as
  real coverage lands.
- `app/components/**` stays unmeasured on purpose (JSX-heavy, e2e territory) —
  widening to it would turn the ratchet into noise.

## Notes

- Route handlers read `DATABASE_URL` lazily via `@/lib/db`, so simply having it
  set (as in CI) routes them at the test DB — no `@/lib/db` mock needed.
- `getServerSession` is still mocked per-test to control auth/role; only the DB
  is real.
- Determinism: `resetDb()` in `beforeEach` guarantees no row leaks between tests,
  and the CI service is health-waited before tests start — no flakiness.
