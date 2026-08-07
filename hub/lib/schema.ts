import { pgTable, text, timestamp, uniqueIndex, jsonb, integer, vector, index, uuid } from 'drizzle-orm/pg-core'

/**
 * Hub database schema — Railway Postgres
 *
 * Multi-tenancy: one schema per tenant is the long-term goal.
 * For now all tables include a `tenant_id` column that scopes every query.
 * Schema-level isolation (search_path) can be added when a second tenant onboards.
 */

/* ── Tenants ─────────────────────────────────────────────────────────────── */

export const tenants = pgTable('tenants', {
  id:        text('id').primaryKey(),               // e.g. 'rxfit'
  name:      text('name').notNull(),                // e.g. 'RxFit Athletics'
  domain:    text('domain'),                        // e.g. 'rxfitatx.com'
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
})

/* ── Hub Users (replaces HUB_ROLES_SHEET_ID) ─────────────────────────────── */

export const hubUsers = pgTable(
  'hub_users',
  {
    id:                text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId:          text('tenant_id').notNull().references(() => tenants.id),
    email:             text('email').notNull(),
    name:              text('name'),
    role:              text('role').notNull().default('onboarding'), // superadmin|admin|staff|onboarding
    assignedProjects:  text('assigned_projects').array().default([]),  // Paperclip company IDs
    assignedBy:        text('assigned_by'),
    assignedAt:        timestamp('assigned_at').defaultNow(),
    lastLogin:         timestamp('last_login'),
    googleRefreshToken: text('google_refresh_token'), // Google OAuth offline refresh token
    createdAt:         timestamp('created_at').defaultNow(),
    updatedAt:         timestamp('updated_at').defaultNow(),
  },
  (t) => ({
    emailTenantUniq: uniqueIndex('hub_users_email_tenant_uniq').on(t.tenantId, t.email),
  })
)

/* ── KPIs (replaces NEXT_PUBLIC_KPI_SHEET_ID) ────────────────────────────── */

export const kpis = pgTable('kpis', {
  id:             text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId:       text('tenant_id').notNull().references(() => tenants.id),
  label:          text('label').notNull(),
  value:          text('value').notNull().default('0'),
  previousValue:  text('previous_value'),                     // last known value — used for trend calc
  unit:           text('unit'),                               // '%', '$', 'units'
  trend:          text('trend'),                              // display string e.g. '+12%'
  trendDirection: text('trend_direction').default('neutral'), // up|down|neutral
  source:         text('source').default('manual'),           // manual|ga4|stripe|gsc|paperclip
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourceConfig:   jsonb('source_config').$type<Record<string, any>>(), // source-specific query params
  scope:          text('scope').default('global'),            // global|project
  companyId:      text('company_id'),                         // Paperclip company ID when scope=project
  visibility:     text('visibility').default('staff'),        // public|staff|admin
  version:        integer('version').notNull().default(1),    // optimistic locking
  lastSyncedAt:   timestamp('last_synced_at'),                // when this row was last auto-refreshed
  updatedAt:      timestamp('updated_at').defaultNow(),
  updatedBy:      text('updated_by'),
  description:    text('description'),                        // markdown note content for the Graph
})

/* ── Event Log (append-only — captures every significant system action) ── */

export const eventLog = pgTable(
  'event_log',
  {
    id:             text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId:       text('tenant_id').notNull().references(() => tenants.id),
    eventType:      text('event_type').notNull(),     // 'issue.created', 'kpi.synced', 'circuit.tripped', 'auth.failed'
    actor:          text('actor').notNull(),           // 'hub-user:email', 'paperclip-agent:id', 'system:cron'
    resourceType:   text('resource_type'),            // 'issue', 'kpi', 'agent', 'run'
    resourceId:     text('resource_id'),              // ID of the affected resource
    payload:        jsonb('payload'),                 // Event-specific data (flexible schema)
    correlationId:  text('correlation_id'),           // Links related events across a request chain
    createdAt:      timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    // Speeds the ai-health read (WHERE event_type LIKE 'telemetry:%' AND
    // created_at >= …) and the retention prune (WHERE tenant_id AND
    // created_at < cutoff) — both otherwise seq-scan an append-only table.
    typeCreatedIdx: index('event_log_type_created_idx').on(t.eventType, t.createdAt),
  }),
)

/* ── Agent Memory (structured knowledge that Paperclip agents can query) ── */

export const agentMemory = pgTable('agent_memory', {
  id:              text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId:        text('tenant_id').notNull().references(() => tenants.id),
  agentId:         text('agent_id').notNull(),          // Which agent owns this memory
  memoryType:      text('memory_type').notNull(),       // 'insight', 'decision', 'error_pattern', 'success_pattern'
  content:         text('content').notNull(),           // The actual knowledge/insight
  context:         jsonb('context'),                    // Structured metadata (project, campaign, etc.)
  relevanceScore:  integer('relevance_score'),          // For future ranking/decay
  expiresAt:       timestamp('expires_at'),             // Optional TTL for time-bound knowledge
  createdAt:       timestamp('created_at').defaultNow().notNull(),
  updatedAt:       timestamp('updated_at').defaultNow().notNull(),
})

/* ── Entity Links (The Graph Edges) ──────────────────────────────────────── */

export const entityLinks = pgTable('entity_links', {
  id:          text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId:    text('tenant_id').notNull().references(() => tenants.id),
  sourceType:  text('source_type').notNull(), // 'kpi', 'agent_memory', 'hub_user', etc.
  sourceId:    text('source_id').notNull(),
  targetType:  text('target_type').notNull(), // 'kpi', 'agent_memory', etc.
  targetId:    text('target_id').notNull(),
  label:       text('label'),                 // Optional context for the edge (e.g., "mentioned in")
  createdAt:   timestamp('created_at').defaultNow().notNull(),
})

/* ── Vector Embeddings (Semantic Search via pgvector) ────────────────────── */

export const documentChunks = pgTable('document_chunks', {
  id:         text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId:   text('tenant_id').notNull().references(() => tenants.id),
  sourceUrl:  text('source_url').notNull(),                        // Link to Google Doc/Email
  content:    text('content').notNull(),                           // The raw text chunk
  embedding:  vector('embedding', { dimensions: 768 }),            // 768-dim MRL truncation — see lib/vector-store EMBEDDING_MODEL
  embeddingModel: text('embedding_model'),                          // model that produced `embedding`; search only trusts rows on the active model
  createdAt:  timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  embeddingIndex: index('document_chunks_embedding_hnsw_idx').using('hnsw', table.embedding.op('vector_cosine_ops'))
}))

/* ── Founder Lens Sections (per-org, per-role C-Suite customization) ────── */
/**
 * Replaces the old filesystem-backed FOUNDER_LENS.md files under
 * ../orchestration, which do not exist in the deployed container.
 * One row per (tenant, org, role); `sections` holds the structured
 * FounderLensCustomSection payload as JSONB.
 */
export const founderLensSections = pgTable(
  'founder_lens_sections',
  {
    id:        text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId:  text('tenant_id').notNull().references(() => tenants.id),
    orgId:     text('org_id').notNull(),                 // Paperclip company id / identifier
    role:      text('role').notNull(),                   // ceo|cmo|cto|cfo|coo|marketing|technical|revenue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sections:  jsonb('sections').$type<Record<string, any>>().notNull(),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    orgRoleUniq: uniqueIndex('founder_lens_org_role_uniq').on(t.tenantId, t.orgId, t.role),
  })
)

/* ── Focus Preferences (per-user Gmail Focus-queue personalization) ─────── */
/**
 * One row per user (tenant + email) holding the personalization the Focus
 * ranker injects: a unified VIP list (each tagged business|personal) and a
 * short free-text "what matters to me now" goals string. Reads are FAIL-OPEN
 * (see lib/focus-preferences.ts) so the ranker still works when the row — or
 * the whole DB — is unavailable.
 */
export const focusPreferences = pgTable(
  'focus_preferences',
  {
    id:        text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId:  text('tenant_id').notNull().references(() => tenants.id),
    email:     text('email').notNull(),
    vips:      jsonb('vips').$type<{ value: string; category: 'business' | 'personal' }[]>().notNull().default([]),
    goals:     text('goals').notNull().default(''),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    emailTenantUniq: uniqueIndex('focus_preferences_email_tenant_uniq').on(t.tenantId, t.email),
  })
)

/* ── Chat Space Preferences (per-user Google Chat panel visibility) ─────── */
/**
 * One row per user (tenant + email) holding which Google Chat spaces they want
 * in the Hub's Chat panel, stored as OVERRIDES on top of the default rule in
 * lib/chat-spaces.ts (named spaces visible; DMs / Meet group chats / bot DMs
 * hidden) rather than as a snapshot list.
 *
 * Overrides — not a snapshot — because Google Chat keeps auto-creating spaces:
 * a snapshot says nothing about a Meet chat that did not exist when it was
 * saved, whereas the default rule hides it on sight. Reads are FAIL-OPEN (see
 * lib/chat-space-preferences-db.ts): a DB outage falls back to the defaults, so
 * the panel degrades to "named spaces only" instead of erroring.
 *
 * This lives in Postgres and not localStorage so the choice survives sign-out,
 * a new browser, a new device and a redeploy.
 */
export const chatSpacePreferences = pgTable(
  'chat_space_preferences',
  {
    id:        text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId:  text('tenant_id').notNull().references(() => tenants.id),
    email:     text('email').notNull(),
    /** Space names forced VISIBLE despite the default rule hiding them. */
    shown:     jsonb('shown').$type<string[]>().notNull().default([]),
    /** Space names forced HIDDEN despite the default rule showing them. */
    hidden:    jsonb('hidden').$type<string[]>().notNull().default([]),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    emailTenantUniq: uniqueIndex('chat_space_prefs_email_tenant_uniq').on(t.tenantId, t.email),
  })
)

/* ── Google Prefs (per-tenant analytics + reporting configuration) ───────── */
/**
 * Which GA4 property and Search Console site this tenant's analytics read from,
 * plus the scheduled-report configuration. Per TENANT, not per user: one
 * business has one set of numbers, and every admin should see the same ones.
 *
 * Replaces the single-property GA4_PROPERTY_ID / GSC_SITE_URL env vars, which
 * could not express more than one tenant. The env vars remain as a fallback so
 * existing deployments keep working before an admin picks a property.
 */
export const googlePrefs = pgTable(
  'google_prefs',
  {
    id:               text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId:         text('tenant_id').notNull().references(() => tenants.id),
    /** Numeric GA4 property id (no "properties/" prefix). */
    ga4PropertyId:    text('ga4_property_id'),
    /** GSC property, either a URL prefix or `sc-domain:example.com`. */
    gscSiteUrl:       text('gsc_site_url'),
    bigqueryProjectId: text('bigquery_project_id'),
    gbpAccountId:     text('gbp_account_id'),
    gbpLocationIds:   jsonb('gbp_location_ids').$type<string[]>().notNull().default([]),
    /** Scheduled report configs — cadence/recipients are admin-configurable. */
    reports:          jsonb('reports').$type<unknown[]>().notNull().default([]),
    /** IANA timezone the report schedule is evaluated in. */
    timezone:         text('timezone'),
    updatedBy:        text('updated_by'),
    updatedAt:        timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    tenantUniq: uniqueIndex('google_prefs_tenant_uniq').on(t.tenantId),
  })
)

/* ── Drive Workspaces (the auto-provisioned "HUB Overlay" folder) ────────── */
/**
 * Cache of each user's Hub folder in their own Google Drive. Drive is the
 * source of truth — this row only saves a rediscovery query on the hot path.
 * A stale/trashed/deleted folder is detected on use and re-provisioned, so a
 * wrong row here degrades to one extra Drive call, never to a broken write.
 */
export const driveWorkspaces = pgTable(
  'drive_workspaces',
  {
    id:           text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId:     text('tenant_id').notNull().references(() => tenants.id),
    email:        text('email').notNull(),
    rootFolderId: text('root_folder_id').notNull(),
    /** { documents: '<id>', presentations: '<id>', … } — filled in lazily as
     *  each subfolder is first needed. */
    folders:      jsonb('folders').$type<Record<string, string>>().notNull().default({}),
    createdAt:    timestamp('created_at').defaultNow().notNull(),
    lastVerifiedAt: timestamp('last_verified_at').defaultNow().notNull(),
  },
  (t) => ({
    emailTenantUniq: uniqueIndex('drive_workspaces_email_tenant_uniq').on(t.tenantId, t.email),
  })
)

/* ── Google OAuth Tokens (durable offline-access credential) ────────────── */
/**
 * The user's Google REFRESH token, kept server-side so the Hub can mint fresh
 * access tokens without dragging the user back through the OAuth consent screen.
 *
 * WHY: the refresh token used to live ONLY inside the NextAuth JWT cookie.
 * Anything that lost that cookie — a new browser, a cleared profile, a phone,
 * an expired session — lost offline access with it, and the only recovery was a
 * full interactive re-consent. That is the "many forced relogins" complaint.
 * With the token durably stored, a re-auth can complete SILENTLY against the
 * grant Google already has on file.
 *
 * SECURITY: this is a bearer credential for the user's Google account. It is
 * written and read exclusively by server-side code (lib/google-token-store.ts),
 * is never returned by an API route, never reaches the session object, and
 * never appears in a log line. Rows are keyed by (tenant, email) — the same
 * scoping every other per-user table uses.
 */
export const googleOauthTokens = pgTable(
  'google_oauth_tokens',
  {
    id:           text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId:     text('tenant_id').notNull().references(() => tenants.id),
    email:        text('email').notNull(),
    refreshToken: text('refresh_token').notNull(),
    /** Space-separated scope list the token was granted with, for diagnostics. */
    scope:        text('scope'),
    updatedAt:    timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    emailTenantUniq: uniqueIndex('google_oauth_tokens_email_tenant_uniq').on(t.tenantId, t.email),
  })
)

/* ── Tool Artifacts (Structured output from skill sessions) ────────────── */

export const toolArtifacts = pgTable('tool_artifacts', {
  id:             text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId:       text('tenant_id').notNull().references(() => tenants.id),
  toolId:         text('tool_id').notNull(),              // e.g. 'issue-tree', 'decision-memo'
  chatId:         text('chat_id'),                        // Links to the chat session that produced this
  title:          text('title').notNull(),                 // User-facing title
  content:        jsonb('content').notNull(),              // Structured JSONB (tool-specific schema)
  contextSummary: text('context_summary'),                 // AI-generated context card text
  status:         text('status').default('active'),        // active | completed | archived
  createdBy:      text('created_by'),                      // User email
  createdAt:      timestamp('created_at').defaultNow().notNull(),
  updatedAt:      timestamp('updated_at').defaultNow().notNull(),
})

/* ── AI Action Log (append-only provenance for AI-initiated actions) ────── */
/**
 * Every AI-initiated side-effecting action (gmail_send / chat_post /
 * task_create / …) writes exactly one append-only row here — success OR
 * failure — so "the AI sent X / created Y" is accountable after the fact.
 *
 * PROVENANCE, NOT CONTENT: `target` holds only routing metadata (recipient /
 * space / taskId), NEVER message bodies. `gate_token_id` is a non-reversible
 * fingerprint of the quality-gate token, NEVER the token itself. See
 * lib/ai-audit.ts (toAuditRow) for the redaction contract this table relies on.
 */
export const aiActionLog = pgTable(
  'ai_action_log',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    userEmail:   text('user_email'),                    // actor's email (nullable — best-effort)
    actor:       text('actor').notNull().default('ai'), // 'ai' | 'user'
    actionType:  text('action_type').notNull(),         // 'gmail_send' | 'chat_post' | 'task_create' | …
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    target:      jsonb('target').$type<Record<string, any>>(), // recipient/space/taskId only — NO bodies
    intent:      text('intent'),                        // declared x-ai-intent
    gateTokenId: text('gate_token_id'),                 // token fingerprint ONLY — never the full token
    requestId:   text('request_id'),                    // correlates with observability telemetry
    status:      text('status').notNull(),              // 'success' | 'failed'
    error:       text('error'),                         // failure reason (e.g. 'rate_limited'), nullable
  },
  (t) => ({
    userCreatedIdx: index('ai_action_log_user_created_idx').on(t.userEmail, t.createdAt.desc()),
  })
)

/* ── Webhook channels (Google Drive push notifications) ──────────────────── */
/**
 * The live Drive watch channel(s) feeding the semantic index. Google push
 * channels EXPIRE (and did so silently — the pgvector index just stopped
 * updating with no error anywhere). This table is what lets the renewal cron
 * (/api/webhooks/google/renew) know a channel exists, when it dies, and where
 * the changes cursor is, so it can renew before expiry and bootstrap from
 * nothing. One row per (tenant, kind); kind is 'drive-changes' today.
 */
export const webhookChannels = pgTable(
  'webhook_channels',
  {
    /** Channel id we mint (uuid) — echoed back by Google as X-Goog-Channel-Id. */
    id:         text('id').primaryKey(),
    tenantId:   text('tenant_id').notNull().references(() => tenants.id),
    kind:       text('kind').notNull(),
    /** Google's opaque resource id — required to STOP a channel. */
    resourceId: text('resource_id').notNull(),
    /** changes.list cursor. Survives channel renewal — the cursor belongs to
     *  the corpus, not to any one channel. */
    pageToken:  text('page_token'),
    /** When Google will stop delivering. The renewal cron re-registers before
     *  this passes. */
    expiration: timestamp('expiration', { withTimezone: true }).notNull(),
    /** Webhook address the channel posts to. */
    address:    text('address').notNull(),
    createdAt:  timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt:  timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantKindUniq: uniqueIndex('webhook_channels_tenant_kind_uniq').on(t.tenantId, t.kind),
  })
)
