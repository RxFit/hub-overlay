import { pgTable, text, timestamp, uniqueIndex, jsonb, integer } from 'drizzle-orm/pg-core'

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
})

/* ── Event Log (append-only — captures every significant system action) ── */

export const eventLog = pgTable('event_log', {
  id:             text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId:       text('tenant_id').notNull().references(() => tenants.id),
  eventType:      text('event_type').notNull(),     // 'issue.created', 'kpi.synced', 'circuit.tripped', 'auth.failed'
  actor:          text('actor').notNull(),           // 'hub-user:email', 'paperclip-agent:id', 'system:cron'
  resourceType:   text('resource_type'),            // 'issue', 'kpi', 'agent', 'run'
  resourceId:     text('resource_id'),              // ID of the affected resource
  payload:        jsonb('payload'),                 // Event-specific data (flexible schema)
  correlationId:  text('correlation_id'),           // Links related events across a request chain
  createdAt:      timestamp('created_at').defaultNow().notNull(),
})

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
