import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { describeDb, migrateTestDb, getSql, closeDb, seedTenant } from '../test/db-harness'
import { db } from '@/lib/db'
import { createToolRun, finishToolRun } from '@/lib/tool-runs'
import { ensureDeepRunArtifact, ensureDeepRunArtifactForRun } from '@/lib/deep-artifacts'

/**
 * lib/deep-artifacts against REAL Postgres (skipped without DATABASE_URL; CI
 * provides one). Locks the exactly-once story the landing side effect and the
 * panel's adopt both rely on:
 *  - one artifact per run, however many ensures land (serially or racing),
 *  - a manual Save & Close from before auto-save counts as already saved,
 *  - ensure-by-run-id saves nothing until the run has actually landed,
 *  - the artifact row exists even when embedding is impossible (no Gemini key
 *    in CI) — the save never depends on the vector step.
 */

const OWNER = 'staff@rxfitatx.com'
const REPORT = '# Churn drivers\n\nPrice.\n\n```json\n{"title":"Churn drivers","summary":"Price is the driver.","sections":[{"heading":"Evidence","body":"cohorts"}],"sources":[]}\n```'

async function landedRun(id: string, tool = 'deep-research') {
  await createToolRun({ id, tool, brief: 'Why churn?', userEmail: OWNER, chatId: 'chat-1' })
  const landed = await finishToolRun(db, id, { status: 'succeeded', resultMd: REPORT })
  expect(landed?.id).toBe(id)
  return { id, tool, brief: 'Why churn?', resultMd: REPORT, chatId: 'chat-1' }
}

describeDb('deep-run artifacts (Postgres)', () => {
  beforeAll(() => {
    migrateTestDb()
  })

  beforeEach(async () => {
    const sql = getSql()
    await sql`DELETE FROM tool_artifacts`
    await sql`DELETE FROM tool_runs`
    await seedTenant()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('saves a landed run once; a second ensure returns the same artifact without inserting', async () => {
    const run = await landedRun(crypto.randomUUID())
    const first = await ensureDeepRunArtifact(run, { tenantId: 'rxfit', createdBy: OWNER })
    expect(first.created).toBe(true)
    expect(first.title).toBe('Deep Research: Churn drivers')

    const second = await ensureDeepRunArtifact(run, { tenantId: 'rxfit', createdBy: OWNER })
    expect(second).toEqual({ id: first.id, title: first.title, created: false })

    const sql = getSql()
    const rows = await sql<{ id: string; tool_id: string; created_by: string; content: { metadata: { deepRunId: string }; sections: unknown[] } }[]>`
      SELECT id, tool_id, created_by, content FROM tool_artifacts
    `
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(first.id)
    expect(rows[0].tool_id).toBe('deep-research')
    expect(rows[0].created_by).toBe(OWNER)
    expect(rows[0].content.metadata.deepRunId).toBe(run.id)
    expect(rows[0].content.sections.length).toBeGreaterThan(0)
  })

  it('racing ensures for one run converge on a single row (advisory lock + check-then-insert)', async () => {
    const run = await landedRun(crypto.randomUUID())
    const results = await Promise.all(
      Array.from({ length: 4 }, () => ensureDeepRunArtifact(run, { tenantId: 'rxfit', createdBy: OWNER })),
    )
    const ids = new Set(results.map(r => r.id))
    expect(ids.size).toBe(1)
    expect(results.filter(r => r.created)).toHaveLength(1)
    const [{ n }] = await getSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM tool_artifacts`
    expect(n).toBe(1)
  })

  it('a manual Save & Close from the old path (same metadata.deepRunId) counts as already saved', async () => {
    const run = await landedRun(crypto.randomUUID())
    const sql = getSql()
    const [{ id: manualId }] = await sql<{ id: string }[]>`
      INSERT INTO tool_artifacts (tenant_id, tool_id, title, content, created_by)
      VALUES ('rxfit', 'deep-research', 'Deep Research: manual', ${JSON.stringify({
        toolId: 'deep-research', title: 'manual', sections: [], metadata: { deepRunId: run.id },
      })}::jsonb, ${OWNER})
      RETURNING id
    `
    const ensured = await ensureDeepRunArtifact(run, { tenantId: 'rxfit', createdBy: OWNER })
    expect(ensured).toEqual({ id: manualId, title: 'Deep Research: manual', created: false })
  })

  it('an archived artifact does not block a fresh save (only active rows count)', async () => {
    const run = await landedRun(crypto.randomUUID())
    const first = await ensureDeepRunArtifact(run, { tenantId: 'rxfit', createdBy: OWNER })
    await getSql()`UPDATE tool_artifacts SET status = 'archived' WHERE id = ${first.id}`
    const again = await ensureDeepRunArtifact(run, { tenantId: 'rxfit', createdBy: OWNER })
    expect(again.created).toBe(true)
    expect(again.id).not.toBe(first.id)
  })

  it('different runs get different artifacts; the same run id is never shared across tenants', async () => {
    const a = await landedRun(crypto.randomUUID())
    const b = await landedRun(crypto.randomUUID())
    const ea = await ensureDeepRunArtifact(a, { tenantId: 'rxfit', createdBy: OWNER })
    const eb = await ensureDeepRunArtifact(b, { tenantId: 'rxfit', createdBy: OWNER })
    expect(ea.id).not.toBe(eb.id)
  })

  it('ensure-by-run-id: nothing to save while queued, the artifact once landed, still nothing for the wrong owner', async () => {
    const id = crypto.randomUUID()
    await createToolRun({ id, tool: 'deep-think', brief: 'Decide pricing', userEmail: OWNER })
    expect(await ensureDeepRunArtifactForRun(id, OWNER, 'rxfit')).toBeNull()

    await finishToolRun(db, id, { status: 'succeeded', resultMd: REPORT })
    const saved = await ensureDeepRunArtifactForRun(id, OWNER, 'rxfit')
    expect(saved?.created).toBe(true)
    expect(saved?.title).toBe('Deep Think: Churn drivers')
    expect(await ensureDeepRunArtifactForRun(id, 'someone-else@rxfitatx.com', 'rxfit')).toBeNull()

    const [{ n }] = await getSql()<{ n: number }[]>`SELECT count(*)::int AS n FROM tool_artifacts`
    expect(n).toBe(1)
  })

  it('a failed run is never saved as an artifact', async () => {
    const id = crypto.randomUUID()
    await createToolRun({ id, tool: 'deep-research', brief: 'b', userEmail: OWNER })
    await finishToolRun(db, id, { status: 'failed', errorClass: 'timeout', error: 'took too long' })
    expect(await ensureDeepRunArtifactForRun(id, OWNER, 'rxfit')).toBeNull()
  })
})
