import { pgTable, text, timestamp, uniqueIndex, jsonb } from 'drizzle-orm/pg-core'

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
  lastSyncedAt:   timestamp('last_synced_at'),                // when this row was last auto-refreshed
  updatedAt:      timestamp('updated_at').defaultNow(),
  updatedBy:      text('updated_by'),
})
