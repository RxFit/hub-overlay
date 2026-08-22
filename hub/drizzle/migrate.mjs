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

const hostMatch = DATABASE_URL.match(/[?&]host=([^&\s]+)/)
const explicitHost = hostMatch ? decodeURIComponent(hostMatch[1]) : undefined

const cleanUrl = DATABASE_URL.replace(/[?&]host=[^&\s]+/, '').replace(/\?$/, '')

// SOCKET-INVARIANT GUARD (P1) — fail early, fail loud. Mirrors lib/db.ts'
// resolveDbConnection (this plain-ESM script runs under `node` before the build
// and can't import the TS module, so the small guard is duplicated). A malformed
// DATABASE_URL would otherwise fall through to a `localhost` TCP connect that
// reaches nothing in Cloud Run and ECONNREFUSEs at the first query instead of
// failing at boot. Refuse to run — matching the missing-DATABASE_URL exit above —
// BEFORE arming the watchdog or opening a connection.
// SECURITY: never log DATABASE_URL / cleanUrl (they carry the DB password); only
// explicitHost (a non-secret /cloudsql/… path) and the loopback host token appear.
if (explicitHost !== undefined) {
  // A ?host= override is always a Cloud SQL Unix socket → must be absolute.
  if (!explicitHost.startsWith('/')) {
    console.error(`[migrate] ❌ DATABASE_URL ?host= override must be an absolute Cloud SQL socket path (e.g. /cloudsql/PROJECT:REGION:INSTANCE), got a non-absolute value: "${explicitHost}".`)
    process.exit(1)
  }
} else if (process.env.NODE_ENV === 'production') {
  // No socket override in production — a loopback/empty host can't reach Cloud
  // SQL. Parse defensively: an unparseable URL is treated as a real host we
  // can't classify, never a guard failure.
  let hostname
  try {
    hostname = new URL(cleanUrl).hostname
  } catch {
    // Unparseable → leave hostname undefined → do not exit.
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '') {
    console.error(`[migrate] ❌ DATABASE_URL resolves to the "${hostname || 'localhost'}" host in production but has no ?host= Cloud SQL socket override — this cannot reach Cloud SQL and will ECONNREFUSE at the first query. Set ?host=/cloudsql/PROJECT:REGION:INSTANCE for the Cloud Run deployment.`)
    process.exit(1)
  }
}

// Watchdog (2026-07-10 deploy outage): this script runs inside the container
// entrypoint, BEFORE the server binds :3000. postgres-js waits 30s per connect
// attempt by default, and a hung/unroutable DB endpoint would otherwise stall
// startup until Cloud Run's probe budget expires — with no log line saying why.
// Bound the whole run; exit code 2 distinguishes "timed out" from "SQL failed".
// unref() lets a successful run exit naturally without waiting on the timer.
const WATCHDOG_MS = Number(process.env.MIGRATE_WATCHDOG_MS || 90_000)
const watchdog = setTimeout(() => {
  console.error(`[migrate] ❌ Watchdog: still running after ${WATCHDOG_MS}ms (DB connect hang?) — aborting. Raise MIGRATE_WATCHDOG_MS if migrations legitimately need longer.`)
  process.exit(2)
}, WATCHDOG_MS)
watchdog.unref()

// connect_timeout (seconds): fail a dead endpoint in 15s with a real error
// instead of postgres-js' 30s default per attempt.
const sql = postgres(cleanUrl, { 
  max: 1, 
  connect_timeout: 15,
  ...(explicitHost && { host: explicitHost })
})

async function run() {
  console.log('[migrate] Connecting to Postgres...')

  // ── pgvector (NON-FATAL) ──
  // CREATE EXTENSION needs superuser-ish privileges (on Cloud SQL:
  // cloudsqlsuperuser). This script was written against Railway Postgres where
  // the app user could do it; on other hosts it may be denied, or the extension
  // may not be installed at all. Semantic search already degrades gracefully at
  // runtime (lib/vector-store callers try/catch), so a missing extension must
  // not abort the rest of the schema — and, via the entrypoint, brick deploys.
  // The dependent table + index below live in the same guarded block.
  let vectorOk = true
  try {
    await sql`
      CREATE EXTENSION IF NOT EXISTS vector;
    `
    console.log('[migrate] ✓ vector extension')
  } catch (err) {
    vectorOk = false
    console.warn(`[migrate] ⚠️ vector extension unavailable (${err.code ?? ''} ${err.message}) — skipping pgvector schema. Semantic search will be degraded until an admin runs CREATE EXTENSION vector as a privileged user.`)
  }

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

  // Composite index on (event_type, created_at) — the append-only event_log is
  // read by ai-health (WHERE event_type LIKE 'telemetry:%' AND created_at >= …)
  // and pruned by retention (WHERE tenant_id AND created_at < cutoff); without
  // this it seq-scans. Idempotent — safe to re-run on every cold start.
  await sql`
    CREATE INDEX IF NOT EXISTS event_log_type_created_idx
    ON event_log (event_type, created_at)
  `
  console.log('[migrate] ✓ event_log (event_type, created_at) index')

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

  // Document Chunks Table (for pgvector semantic search) — depends on the
  // vector extension, so it shares the NON-FATAL guard above: without the
  // extension the VECTOR(768) column type doesn't exist and these statements
  // can only fail. Skipping (with a loud warning) keeps the rest of the schema
  // applying and the container bootable.
  if (vectorOk) {
    try {
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

      // Tag each embedding with the model that produced it. gemini-embedding-001
      // (EOL 2026-07-14) and its successor gemini-embedding-2 produce INCOMPATIBLE
      // vector spaces; lib/vector-store filters search to the active model so old
      // and new vectors never mix. Existing rows stay NULL (implicitly old) until
      // scripts/reembed-document-chunks.mjs backfills them. Idempotent.
      await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT`
      console.log('[migrate] ✓ document_chunks embedding_model column check')
    } catch (err) {
      console.warn(`[migrate] ⚠️ pgvector schema failed (${err.code ?? ''} ${err.message}) — skipping document_chunks. Semantic search degraded; rest of schema continues.`)
    }
  } else {
    console.warn('[migrate] ⚠️ Skipping document_chunks table/index (vector extension unavailable).')
  }

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

  // Focus Preferences — per-user Gmail Focus-queue personalization (VIP list +
  // goals). One row per (tenant, email); reads are fail-open in the app.
  await sql`
    CREATE TABLE IF NOT EXISTS focus_preferences (
      id         TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id  TEXT NOT NULL REFERENCES tenants(id),
      email      TEXT NOT NULL,
      vips       JSONB NOT NULL DEFAULT '[]'::jsonb,
      goals      TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS focus_preferences_email_tenant_uniq
    ON focus_preferences(tenant_id, email)
  `
  console.log('[migrate] ✓ focus_preferences table')

  // Chat Space Preferences — per-user Google Chat panel visibility, stored as
  // overrides on the default rule (named spaces on; DMs / Meet group chats /
  // bot DMs off). One row per (tenant, email); reads are fail-open in the app.
  await sql`
    CREATE TABLE IF NOT EXISTS chat_space_preferences (
      id         TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id  TEXT NOT NULL REFERENCES tenants(id),
      email      TEXT NOT NULL,
      shown      JSONB NOT NULL DEFAULT '[]'::jsonb,
      hidden     JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS chat_space_prefs_email_tenant_uniq
    ON chat_space_preferences(tenant_id, email)
  `
  console.log('[migrate] ✓ chat_space_preferences table')

  // Google OAuth Tokens — durable per-user REFRESH token so a lost session
  // cookie no longer costs the user their offline grant (and a forced consent
  // screen). Server-side read/write only; never leaves the backend.
  await sql`
    CREATE TABLE IF NOT EXISTS google_oauth_tokens (
      id            TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     TEXT NOT NULL REFERENCES tenants(id),
      email         TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      scope         TEXT,
      updated_at    TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS google_oauth_tokens_email_tenant_uniq
    ON google_oauth_tokens(tenant_id, email)
  `
  console.log('[migrate] ✓ google_oauth_tokens table')

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

  // Drive workspaces — cache of each user's auto-provisioned "HUB Overlay"
  // folder. Drive stays the source of truth; a stale row costs one extra
  // rediscovery query, never a failed write.
  await sql`
    CREATE TABLE IF NOT EXISTS drive_workspaces (
      id               TEXT PRIMARY KEY,
      tenant_id        TEXT NOT NULL REFERENCES tenants(id),
      email            TEXT NOT NULL,
      root_folder_id   TEXT NOT NULL,
      folders          JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at       TIMESTAMPTZ DEFAULT now() NOT NULL,
      last_verified_at TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS drive_workspaces_email_tenant_uniq
    ON drive_workspaces(tenant_id, email)
  `
  console.log('[migrate] ✓ drive_workspaces table')

  // Google prefs — per-tenant GA4 property / GSC site selection and scheduled
  // report configuration. Replaces the single-property env vars (kept as a
  // fallback so existing deploys keep working until an admin picks one).
  await sql`
    CREATE TABLE IF NOT EXISTS google_prefs (
      id                  TEXT PRIMARY KEY,
      tenant_id           TEXT NOT NULL REFERENCES tenants(id),
      ga4_property_id     TEXT,
      gsc_site_url        TEXT,
      bigquery_project_id TEXT,
      gbp_account_id      TEXT,
      gbp_location_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
      reports             JSONB NOT NULL DEFAULT '[]'::jsonb,
      timezone            TEXT,
      updated_by          TEXT,
      updated_at          TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS google_prefs_tenant_uniq
    ON google_prefs(tenant_id)
  `
  console.log('[migrate] ✓ google_prefs table')

  // Webhook channels — the live Drive watch channel(s) feeding the semantic
  // index. Push channels expire; the renewal cron reads/writes this table.
  await sql`
    CREATE TABLE IF NOT EXISTS webhook_channels (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL REFERENCES tenants(id),
      kind         TEXT NOT NULL,
      resource_id  TEXT NOT NULL,
      page_token   TEXT,
      expiration   TIMESTAMPTZ NOT NULL,
      address      TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at   TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS webhook_channels_tenant_kind_uniq
    ON webhook_channels(tenant_id, kind)
  `
  console.log('[migrate] ✓ webhook_channels table')

  // Seed rxfit tenant
  // Conversations (Phase 2) — server-side chat persistence. Chat ids are
  // client-minted; ownership is the session email (enforced in lib/chat-store).
  await sql`
    CREATE TABLE IF NOT EXISTS chats (
      id         TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      title      TEXT,
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  await sql`
    CREATE INDEX IF NOT EXISTS chats_user_updated_idx
    ON chats (user_email, updated_at DESC)
  `
  await sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         TEXT PRIMARY KEY,
      chat_id    TEXT NOT NULL REFERENCES chats(id),
      seq        SERIAL NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      model      TEXT,
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  await sql`
    CREATE INDEX IF NOT EXISTS chat_messages_chat_seq_idx
    ON chat_messages (chat_id, seq)
  `
  console.log('[migrate] ✓ chats + chat_messages tables')

  // AI runs ledger (Phase 2 of the agy migration) — one row per model run,
  // engine-agnostic ('agy' | 'gemini' | 'claude'). Provenance only: the prompt
  // is stored as length + sha256 fingerprint, never as text; responses and raw
  // envelopes are never persisted (same redaction contract as ai_action_log).
  await sql`
    CREATE TABLE IF NOT EXISTS ai_runs (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at        TIMESTAMPTZ DEFAULT now() NOT NULL,
      engine            TEXT NOT NULL,
      model             TEXT,
      source            TEXT NOT NULL,
      status            TEXT NOT NULL,
      error_class       TEXT,
      error             TEXT,
      latency_ms        INTEGER NOT NULL,
      input_tokens      INTEGER,
      output_tokens     INTEGER,
      cache_read_tokens INTEGER,
      total_tokens      INTEGER,
      prompt_chars      INTEGER,
      prompt_sha256     TEXT,
      request_id        TEXT,
      user_email        TEXT,
      meta              JSONB
    )
  `
  await sql`
    CREATE INDEX IF NOT EXISTS ai_runs_created_idx
    ON ai_runs (created_at DESC)
  `
  console.log('[migrate] ✓ ai_runs table')

  // Desktop dispatch (Phase 2.5) — the allotment job queue. Cloud Run cannot
  // refresh the consumer OAuth token (datacenter-IP rejection); the desktop
  // worker long-polls these rows outbound. Content columns (payload_text,
  // result_text) are transient by contract — nulled on delivery/terminal
  // transitions; provenance (prompt_chars + prompt_sha256) survives.
  await sql`
    CREATE TABLE IF NOT EXISTS dispatch_jobs (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at          TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at          TIMESTAMPTZ DEFAULT now() NOT NULL,
      kind                TEXT NOT NULL,
      priority            INTEGER DEFAULT 100 NOT NULL,
      state               TEXT DEFAULT 'queued' NOT NULL,
      attempt             INTEGER DEFAULT 0 NOT NULL,
      max_attempts        INTEGER DEFAULT 1 NOT NULL,
      deadline_at         TIMESTAMPTZ NOT NULL,
      payload_text        TEXT,
      payload_meta        JSONB,
      prompt_chars        INTEGER,
      prompt_sha256       TEXT,
      leased_by           TEXT,
      leased_at           TIMESTAMPTZ,
      lease_expires_at    TIMESTAMPTZ,
      cancel_requested_at TIMESTAMPTZ,
      result_text         TEXT,
      result_meta         JSONB,
      error_class         TEXT,
      error               TEXT,
      latency_ms          INTEGER,
      finished_at         TIMESTAMPTZ,
      delivered_at        TIMESTAMPTZ,
      scrubbed_at         TIMESTAMPTZ,
      request_id          TEXT
    )
  `
  await sql`
    CREATE INDEX IF NOT EXISTS dispatch_jobs_claim_idx
    ON dispatch_jobs (state, priority, created_at)
  `
  await sql`
    CREATE INDEX IF NOT EXISTS dispatch_jobs_created_idx
    ON dispatch_jobs (created_at DESC)
  `
  await sql`
    CREATE TABLE IF NOT EXISTS dispatch_workers (
      id            TEXT PRIMARY KEY,
      first_seen_at TIMESTAMPTZ DEFAULT now() NOT NULL,
      last_seen_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
      version       TEXT,
      agy_version   TEXT,
      meta          JSONB
    )
  `
  console.log('[migrate] ✓ dispatch_jobs + dispatch_workers tables')

  // Hub Secrets — operator-managed third-party credentials, moved off
  // Paperclip's Secrets API when Paperclip was retired. `ciphertext` is an
  // AES-256-GCM envelope (lib/secret-crypto.ts), never a plaintext value.
  // `key_id` duplicates the envelope's key id as a column so a key rotation
  // can find the rows that still need re-sealing in one indexed query.
  // company_id is deliberately NOT a foreign key — workspaces were a
  // Paperclip concept and no Hub table owns them; scoping is enforced in
  // lib/secrets-store.ts.
  await sql`
    CREATE TABLE IF NOT EXISTS hub_secrets (
      id          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   TEXT NOT NULL REFERENCES tenants(id),
      company_id  TEXT NOT NULL,
      name        TEXT NOT NULL,
      ciphertext  TEXT NOT NULL,
      key_id      TEXT NOT NULL,
      provider    TEXT,
      created_by  TEXT,
      created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS hub_secrets_scope_name_uniq
    ON hub_secrets(tenant_id, company_id, name)
  `
  await sql`
    CREATE INDEX IF NOT EXISTS hub_secrets_key_id_idx
    ON hub_secrets(key_id)
  `
  console.log('[migrate] \u2713 hub_secrets table')

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
  // Include the Postgres error code (e.g. 42501 insufficient_privilege,
  // 28P01 bad password, ECONNREFUSED) — the message alone is often ambiguous
  // in Cloud Run logs, and this line is the primary diagnostic when the
  // entrypoint reports a failed migration.
  console.error(`[migrate] ❌ Failed (${err.code ?? 'no-code'}):`, err.message)
  process.exit(1)
})
