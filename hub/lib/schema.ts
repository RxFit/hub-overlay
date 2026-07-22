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
