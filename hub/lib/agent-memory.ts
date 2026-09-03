import { db } from './db'
import { agentMemory, eventLog } from './schema'
import { eq, and, like, desc, lt } from 'drizzle-orm'
import { createLogger } from './logger'
import { getTenantId } from './tenant-context'

const log = createLogger('agent-memory')

export interface MemoryInput {
  agentId: string
  memoryType: 'insight' | 'decision' | 'error_pattern' | 'success_pattern'
  content: string
  context?: Record<string, unknown> | null
  relevanceScore?: number | null
  expiresAt?: Date | null
  tenantId?: string
}

/**
 * Stores a piece of structured AI agent memory in the DB.
 */
export async function storeMemory(input: MemoryInput, tx?: any) {
  const tenantId = input.tenantId || getTenantId()
  if (!input.tenantId) {
    log.debug({ agentId: input.agentId }, 'storeMemory: no explicit tenantId — resolved via getTenantId() fallback')
  }
  const client = tx || db

  log.info({ agentId: input.agentId, memoryType: input.memoryType }, 'Storing agent memory')

  return client
    .insert(agentMemory)
    .values({
      tenantId,
      agentId: input.agentId,
      memoryType: input.memoryType,
      content: input.content,
      context: input.context ?? null,
      relevanceScore: input.relevanceScore ?? 5,
      expiresAt: input.expiresAt ?? null,
    })
    .returning()
}

/**
 * Queries the agent memories with optional filters and keyword search.
 */
export async function queryMemories(opts: {
  agentId?: string
  memoryType?: string
  searchQuery?: string
  limit?: number
  tenantId?: string
}) {
  const tenantId = opts.tenantId || getTenantId()
  if (!opts.tenantId) {
    log.debug('queryMemories: no explicit tenantId — resolved via getTenantId() fallback')
  }

  const conditions = [eq(agentMemory.tenantId, tenantId)]

  if (opts.agentId) {
    conditions.push(eq(agentMemory.agentId, opts.agentId))
  }

  if (opts.memoryType) {
    conditions.push(eq(agentMemory.memoryType, opts.memoryType))
  }

  if (opts.searchQuery) {
    conditions.push(like(agentMemory.content, `%${opts.searchQuery}%`))
  }

  log.debug({ conditionsCount: conditions.length }, 'Querying agent memories')

  return db
    .select()
    .from(agentMemory)
    .where(and(...conditions))
    .orderBy(desc(agentMemory.createdAt))
    .limit(opts.limit ?? 50)
}

/**
 * Delete a specific memory by its UUID.
 */
export async function deleteMemory(id: string, tenantId: string): Promise<void> {
  log.info({ id }, 'Deleting agent memory')
  await db
    .delete(agentMemory)
    .where(and(eq(agentMemory.id, id), eq(agentMemory.tenantId, tenantId)))
}

/**
 * Prunes memories that have passed their expiration date (expiresAt < now).
 */
export async function pruneExpiredMemories(tenantId: string): Promise<void> {
  const now = new Date()
  log.info('Running TTL pruning for expired agent memories')
  await db
    .delete(agentMemory)
    .where(and(eq(agentMemory.tenantId, tenantId), lt(agentMemory.expiresAt, now)))
}

/**
 * Prunes `event_log` rows older than `days` (default 30) across ALL tenants
 * and returns the deleted row count.
 *
 * ALL-TENANTS ON PURPOSE (ERROR_REPORTING_2026-08-24.md §8 "Volume control",
 * Retention row :938): the previous version filtered on
 * `tenant_id = getTenantId()`, so any row that
 * landed under a different tenant_id — a fault written with an unexpected
 * tenant, a row from a since-removed tenant — was immortal. Retention is a
 * storage-hygiene concern for the table, not a per-tenant read, so the WHERE
 * clause is `created_at < cutoff` and nothing else.
 *
 * CALLED FROM THE HOURLY TICK, NOT A BUTTON: this used to run only from
 * POST /api/kpis/sync (spec §2.3) — a user clicking "sync KPIs" in settings
 * silently ran a 30-day delete, and a deploy where nobody clicked ran none.
 * lib/retention.ts's runRetention() now calls it from
 * defaultAlertTickDeps.housekeep (lib/dispatch-alerts.ts), the cron-driven
 * hourly tick the spec designates as the home for housekeeping.
 *
 * INDEX CAVEAT: `event_log_type_created_idx` is on (event_type, created_at)
 * — it leads on event_type, so this delete's `created_at < cutoff` predicate
 * cannot use it and the statement scans the table. That is tolerable hourly
 * on a 30-day-bounded table; the spec (§8 "Indexes the reads actually need"
 * row, :939) schedules `CREATE INDEX CONCURRENTLY IF NOT EXISTS … ON
 * event_log (created_at)` for Phase 4, alongside the fingerprint expression
 * index the fault aggregations need. The index is deliberately NOT added
 * here only because the spec assigns it to Phase 4 with that DDL — there is
 * no mechanical obstacle: drizzle/migrate.mjs runs every statement as a
 * standalone autocommit `await sql` tagged-template call (no BEGIN or
 * transaction anywhere in the file), so CONCURRENTLY will run there when
 * Phase 4 lands.
 */
export async function pruneOldEventLogs(days = 30): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  log.info({ cutoff, days }, 'Pruning event logs older than retention window (all tenants)')
  const result = await db.delete(eventLog).where(lt(eventLog.createdAt, cutoff))
  // postgres-js exposes the affected-row count as `count` (drizzle's
  // postgres-js driver returns the RowList, not a pg `rowCount`).
  return result.count
}
