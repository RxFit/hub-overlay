import { it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  describeDb,
  migrateTestDb,
  resetDb,
  getSql,
  closeDb,
} from '../test/db-harness'
import {
  storeMemory,
  queryMemories,
  deleteMemory,
  pruneExpiredMemories,
  pruneOldEventLogs,
} from '@/lib/agent-memory'

/* ════════════════════════════════════════════════════════════════════════════
   DB-BACKED lib/agent-memory (NS-8).

   Structured agent knowledge lives in `agent_memory`; this suite exercises the
   real insert/filter/delete/TTL-prune paths against Postgres, plus the
   event-log retention prune. Gated with describeDb — skips locally without
   DATABASE_URL, runs in CI.
   ════════════════════════════════════════════════════════════════════════════ */

const TENANT = 'rxfit'

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
}

describeDb('lib/agent-memory — DB-backed', () => {
  beforeAll(() => {
    migrateTestDb()
  })

  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('storeMemory persists a row with defaults (relevanceScore 5, null expiry)', async () => {
    const [row] = await storeMemory({
      agentId: 'agent-1',
      memoryType: 'insight',
      content: 'Customers churn after onboarding stalls',
      tenantId: TENANT,
    })

    expect(row.id).toBeTruthy()
    expect(row.relevanceScore).toBe(5)
    expect(row.expiresAt).toBeNull()

    const [db] = await getSql()<{ content: string; memory_type: string }[]>`
      SELECT content, memory_type FROM agent_memory WHERE id = ${row.id}
    `
    expect(db.content).toBe('Customers churn after onboarding stalls')
    expect(db.memory_type).toBe('insight')
  })

  it('queryMemories filters by agentId, memoryType, and keyword — newest first', async () => {
    await storeMemory(
      { agentId: 'a1', memoryType: 'insight', content: 'pricing page converts', tenantId: TENANT },
    )
    await storeMemory(
      { agentId: 'a1', memoryType: 'error_pattern', content: 'retry storm on 503', tenantId: TENANT },
    )
    await storeMemory(
      { agentId: 'a2', memoryType: 'insight', content: 'pricing experiment failed', tenantId: TENANT },
    )

    const byAgent = await queryMemories({ agentId: 'a1', tenantId: TENANT })
    expect(byAgent).toHaveLength(2)

    const byType = await queryMemories({ agentId: 'a1', memoryType: 'insight', tenantId: TENANT })
    expect(byType).toHaveLength(1)
    expect(byType[0].content).toBe('pricing page converts')

    const byKeyword = await queryMemories({ searchQuery: 'pricing', tenantId: TENANT })
    expect(byKeyword).toHaveLength(2)

    const limited = await queryMemories({ limit: 1, tenantId: TENANT })
    expect(limited).toHaveLength(1)
  })

  it('deleteMemory removes exactly the targeted row and respects tenant scope', async () => {
    const [keep] = await storeMemory({
      agentId: 'a1',
      memoryType: 'insight',
      content: 'keep me',
      tenantId: TENANT,
    })
    const [drop] = await storeMemory({
      agentId: 'a1',
      memoryType: 'insight',
      content: 'drop me',
      tenantId: TENANT,
    })

    // Wrong tenant → no-op (tenant scoping is part of the WHERE clause).
    await deleteMemory(drop.id, 'some-other-tenant')
    let remaining = await queryMemories({ agentId: 'a1', tenantId: TENANT })
    expect(remaining).toHaveLength(2)

    await deleteMemory(drop.id, TENANT)
    remaining = await queryMemories({ agentId: 'a1', tenantId: TENANT })
    expect(remaining.map((m) => m.id)).toEqual([keep.id])
  })

  it('pruneExpiredMemories deletes only rows past their TTL', async () => {
    await storeMemory({
      agentId: 'a1',
      memoryType: 'insight',
      content: 'expired',
      expiresAt: daysFromNow(-1),
      tenantId: TENANT,
    })
    await storeMemory({
      agentId: 'a1',
      memoryType: 'insight',
      content: 'still valid',
      expiresAt: daysFromNow(+1),
      tenantId: TENANT,
    })
    await storeMemory({
      agentId: 'a1',
      memoryType: 'insight',
      content: 'immortal (no TTL)',
      tenantId: TENANT,
    })

    await pruneExpiredMemories(TENANT)

    const remaining = await queryMemories({ agentId: 'a1', tenantId: TENANT })
    expect(remaining.map((m) => m.content).sort()).toEqual(['immortal (no TTL)', 'still valid'])
  })

  it('pruneOldEventLogs enforces the 30-day retention window', async () => {
    const sql = getSql()
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    await sql`
      INSERT INTO event_log (tenant_id, event_type, actor, created_at)
      VALUES
        (${TENANT}, 'kpi.synced', 'system:cron', ${fortyDaysAgo}),
        (${TENANT}, 'issue.created', 'system:cron', now())
    `

    await pruneOldEventLogs(TENANT)

    const rows = await sql<{ event_type: string }[]>`
      SELECT event_type FROM event_log WHERE tenant_id = ${TENANT}
    `
    expect(rows.map((r) => r.event_type)).toEqual(['issue.created'])
  })
})
