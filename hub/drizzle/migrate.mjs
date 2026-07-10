/**
 * Hub DB migration + seed script
 * Run: node drizzle/migrate.mjs
 */
import postgres from 'postgres'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('[migrate] DATABASE_URL is not set. Refusing to run without an explicit connection string.')
  process.exit(1)
}

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

  // Migration patch — add updated_at to hub_users if it was created without it
  await sql`
    ALTER TABLE hub_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()
  `
  console.log('[migrate] ✓ hub_users updated_at column check')

  // Migration patch — Google OAuth refresh token (folds in the previously
  // ad-hoc run-migration.js so this column is created idempotently on every
  // cold start, in sync with lib/schema.ts). Was never in migrate.mjs or the
  // ORM schema, so a fresh DB was missing it.
  await sql`
    ALTER TABLE hub_users ADD COLUMN IF NOT EXISTS google_refresh_token TEXT
  `
  console.log('[migrate] ✓ hub_users google_refresh_token column check')

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

  // Founder Lens Sections table (replaces filesystem FOUNDER_LENS.md)
  await sql`
    CREATE TABLE IF NOT EXISTS founder_lens_sections (
      id         TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id  TEXT NOT NULL REFERENCES tenants(id),
      org_id     TEXT NOT NULL,
      role       TEXT NOT NULL,
      sections   JSONB NOT NULL,
      updated_by TEXT,
      updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS founder_lens_org_role_uniq
    ON founder_lens_sections(tenant_id, org_id, role)
  `
  console.log('[migrate] ✓ founder_lens_sections table')

  // AI Action Log — append-only provenance for AI-initiated actions (NS-2).
  // Strictly additive; no backfill. `target` holds routing metadata only (no
  // bodies); `gate_token_id` is a token fingerprint (never the full token).
  await sql`
    CREATE TABLE IF NOT EXISTS ai_action_log (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
      user_email    TEXT,
      actor         TEXT NOT NULL DEFAULT 'ai',
      action_type   TEXT NOT NULL,
      target        JSONB,
      intent        TEXT,
      gate_token_id TEXT,
      request_id    TEXT,
      status        TEXT NOT NULL,
      error         TEXT
    )
  `
  await sql`
    CREATE INDEX IF NOT EXISTS ai_action_log_user_created_idx
    ON ai_action_log (user_email, created_at DESC)
  `
  console.log('[migrate] ✓ ai_action_log table')

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
