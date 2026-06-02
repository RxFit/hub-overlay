/**
 * Hub DB migration + seed script
 * Run: node drizzle/migrate.mjs
 */
import postgres from 'postgres'

const DATABASE_URL = 'postgresql://postgres:REDACTED_PASSWORD@localhost:5432/railway'

const sql = postgres(DATABASE_URL, { max: 1 })

async function run() {
  console.log('[migrate] Connecting to Railway Postgres...')

  await sql`
    CREATE TABLE IF NOT EXISTS tenants (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      domain      TEXT,
      created_at  TIMESTAMPTZ DEFAULT now()
    )
  `
  console.log('[migrate] ✓ tenants table')

  await sql`
    CREATE TABLE IF NOT EXISTS hub_users (
      id                TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id         TEXT NOT NULL REFERENCES tenants(id),
      email             TEXT NOT NULL,
      name              TEXT,
      role              TEXT NOT NULL DEFAULT 'onboarding',
      assigned_projects TEXT[] DEFAULT '{}',
      assigned_by       TEXT,
      assigned_at       TIMESTAMPTZ DEFAULT now(),
      last_login        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT now(),
      UNIQUE(tenant_id, email)
    )
  `
  console.log('[migrate] ✓ hub_users table')

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS hub_users_email_tenant_uniq
    ON hub_users(tenant_id, email)
  `

  await sql`
    CREATE TABLE IF NOT EXISTS kpis (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       TEXT NOT NULL REFERENCES tenants(id),
      label           TEXT NOT NULL,
      value           TEXT NOT NULL DEFAULT '0',
      unit            TEXT,
      trend           TEXT,
      trend_direction TEXT DEFAULT 'neutral',
      source          TEXT DEFAULT 'manual',
      scope           TEXT DEFAULT 'global',
      company_id      TEXT,
      visibility      TEXT DEFAULT 'staff',
      updated_at      TIMESTAMPTZ DEFAULT now(),
      updated_by      TEXT
    )
  `
  console.log('[migrate] ✓ kpis table')

  // Seed rxfit tenant
  await sql`
    INSERT INTO tenants (id, name, domain)
    VALUES ('rxfit', 'RxFit Athletics', 'rxfitatx.com')
    ON CONFLICT (id) DO NOTHING
  `
  console.log('[migrate] ✓ seeded rxfit tenant')

  await sql.end()
  console.log('[migrate] ✅ Done — all tables created and rxfit tenant seeded')
}

run().catch(err => {
  console.error('[migrate] ❌ Failed:', err.message)
  process.exit(1)
})
