/**
 * Hub DB migration + seed script
 * Run: node drizzle/migrate.mjs
 */
import postgres from 'postgres'

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:REDACTED_PASSWORD@localhost:5432/railway'

const sql = postgres(DATABASE_URL, { max: 1 })

async function run() {
  console.log('[migrate] Connecting to Railway Postgres...')

  await sql`
    CREATE EXTENSION IF NOT EXISTS vector;
  `
  console.log('[migrate] ✓ vector extension')

  await sql`
    CREATE TABLE IF NOT EXISTS tenants (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      domain      TEXT,
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now()
    )
  `
  console.log('[migrate] ✓ tenants table')

  await sql`
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
  `
  console.log('[migrate] ✓ tenants updated_at column check')

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

  // Migration 0001 — KPI sync columns (safe to re-run)
  await sql`
    ALTER TABLE kpis
      ADD COLUMN IF NOT EXISTS previous_value   TEXT,
      ADD COLUMN IF NOT EXISTS source_config    JSONB,
      ADD COLUMN IF NOT EXISTS last_synced_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS version          INTEGER DEFAULT 1 NOT NULL,
      ADD COLUMN IF NOT EXISTS description      TEXT
  `
  console.log('[migrate] ✓ kpis sync columns & version (0001)')

  // Event Log Table
  await sql`
    CREATE TABLE IF NOT EXISTS event_log (
      id             TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      TEXT NOT NULL REFERENCES tenants(id),
      event_type     TEXT NOT NULL,
      actor          TEXT NOT NULL,
      resource_type  TEXT,
      resource_id    TEXT,
      payload        JSONB,
      correlation_id TEXT,
      created_at     TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  console.log('[migrate] ✓ event_log table')

  // Agent Memory Table
  await sql`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       TEXT NOT NULL REFERENCES tenants(id),
      agent_id        TEXT NOT NULL,
      memory_type     TEXT NOT NULL,
      content         TEXT NOT NULL,
      context         JSONB,
      relevance_score INTEGER,
      expires_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at      TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  console.log('[migrate] ✓ agent_memory table')

  // Entity Links Table
  await sql`
    CREATE TABLE IF NOT EXISTS entity_links (
      id          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      source_type TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      label       TEXT,
      created_at  TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  console.log('[migrate] ✓ entity_links table')

  // Document Chunks Table (for pgvector semantic search)
  await sql`
    CREATE TABLE IF NOT EXISTS document_chunks (
      id          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      source_url  TEXT NOT NULL,
      content     TEXT NOT NULL,
      embedding   VECTOR(768),
      created_at  TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  console.log('[migrate] ✓ document_chunks table')

  // Create HNSW index for pgvector search
  await sql`
    CREATE INDEX IF NOT EXISTS document_chunks_embedding_hnsw_idx 
    ON document_chunks USING hnsw (embedding vector_cosine_ops);
  `
  console.log('[migrate] ✓ document_chunks HNSW index')

  // Create tool_artifacts table
  await sql`
    CREATE TABLE IF NOT EXISTS tool_artifacts (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       TEXT NOT NULL REFERENCES tenants(id),
      tool_id         TEXT NOT NULL,
      chat_id         TEXT,
      title           TEXT NOT NULL,
      content         JSONB NOT NULL,
      context_summary TEXT,
      status          TEXT DEFAULT 'active',
      created_by      TEXT,
      created_at      TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at      TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  console.log('[migrate] ✓ tool_artifacts table')

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
