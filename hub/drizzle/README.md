# Database migrations

This project has **one canonical migrator** plus a generated history. Don't confuse them.

## Canonical: `migrate.mjs`

`node drizzle/migrate.mjs` is what runs against the database (Railway Postgres).
It is **idempotent** — every statement uses `CREATE TABLE IF NOT EXISTS` /
`ADD COLUMN IF NOT EXISTS`, so it is safe to re-run on every deploy. It creates
the full schema, including `founder_lens_sections`.

Requires `DATABASE_URL` to be set; it refuses to run without one (no fallback).

### Adding a table or column

1. Update `lib/schema.ts` (the Drizzle schema — the app's source of truth for types).
2. Add the matching `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
   block to `migrate.mjs`.
3. (Optional) Generate a Drizzle history file for the record — see below.

## Generated history: `NNNN_*.sql` + `meta/`

The timestamped `0000_*.sql … 0004_*.sql` files and `meta/_journal.json` are the
output of `drizzle-kit generate`. They are kept as a schema-change ledger and are
**not** the deploy path. If you adopt `drizzle-kit migrate` later, regenerate the
journal so it includes every SQL file (e.g. `0004_founder_lens_sections.sql`,
which was added by hand and is applied via `migrate.mjs`).

> Removed in cleanup: the standalone `0000_init.sql` and `0001_kpi_sync_cols.mjs`
> scripts — both were fully superseded by `migrate.mjs` and referenced by nothing.
