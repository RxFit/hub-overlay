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
 * Prunes event logs older than 30 days to optimize DB size.
 */
export async function pruneOldEventLogs(tenantId: string): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  log.info({ cutoff }, 'Pruning event logs older than 30 days')
  await db
    .delete(eventLog)
    .where(and(eq(eventLog.tenantId, tenantId), lt(eventLog.createdAt, cutoff)))
}
