import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { describeDb, migrateTestDb, getSql, closeDb, seedTenant, lockSuite } from '../test/db-harness'
import { db } from '@/lib/db'
import { createToolRun, finishToolRun } from '@/lib/tool-runs'
import { ensureDeepRunArtifact, ensureDeepRunArtifactForRun } from '@/lib/deep-artifacts'
import { getToolArtifacts } from '@/lib/tool-artifacts'

/**
 * lib/deep-artifacts against REAL Postgres (skipped without DATABASE_URL; CI
 * provides one). Locks the exactly-once story the landing side effect and the
 * panel's adopt both rely on:
 *  - one artifact per run, however many ensures land (serially or racing),
 *  - a manual Save & Close from before auto-save counts as already saved,
 *  - another user's row naming the run never blocks the owner's save,
 *  - ensure-by-run-id saves nothing until the run has actually landed,
 *  - the artifact row exists even when embedding is impossible (no Gemini key
 *    in CI) — the save never depends on the vector step.
 *
 * ISOLATION: vitest runs test FILES in parallel workers against the one test
 * database, and tests/dispatch-db.test.ts exercises tool_runs at the same
 * time. This suite therefore owns a private namespace of owner emails
 * (`deep-artifacts-*`) and only ever deletes/counts its own rows — a shared
 * owner email would trip the tool_runs_one_active_per_user index across
 * suites, and a whole-table DELETE would erase the other suite's rows
 * mid-test. Namespacing closes this suite's side; the harness suite lock
 * (lockSuite in beforeAll, held until closeDb) closes the other direction —
 * dispatch-db's own unscoped DELETE can no longer land mid-test here.
 */

const NS = 'deep-artifacts-'
const OWNER = `${NS}owner@rxfitatx.com`
const COLLEAGUE = `${NS}colleague@rxfitatx.com`
const MIXED_CASE = `${NS}Mixed@RxFitATX.com`
const STRANGER = `${NS}stranger@rxfitatx.com`
const REPORT = '# Churn drivers\n\nPrice.\n\n```json\n{"title":"Churn drivers","summary":"Price is the driver.","sections":[{"heading":"Evidence","body":"cohorts"}],"sources":[]}\n```'

async function landedRun(id: string, tool = 'deep-research', userEmail = OWNER) {
  await createToolRun({ id, tool, brief: 'Why churn?', userEmail, chatId: 'chat-1' })
  const landed = await finishToolRun(db, id, { status: 'succeeded', resultMd: REPORT })
  expect(landed?.id).toBe(id)
  return { id, tool, brief: 'Why churn?', resultMd: REPORT, chatId: 'chat-1' }
}

/** Only THIS suite's artifact rows. */
async function ownRows() {
  return getSql()<{ id: string; tool_id: string; created_by: string; content: { metadata: { deepRunId: string }; sections: unknown[] } }[]>`
    SELECT id, tool_id, created_by, content FROM tool_artifacts
    WHERE lower(created_by) LIKE ${`${NS}%`}
    ORDER BY created_at
  `
}

describeDb('deep-run artifacts (Postgres)', () => {
  beforeAll(async () => {
    migrateTestDb()
    // Serialize with tests/dispatch-db.test.ts (see ISOLATION above).
    await lockSuite()
  })

  beforeEach(async () => {
    const sql = getSql()
    // Namespace-scoped cleanup — never the whole table (see ISOLATION above).
    await sql`DELETE FROM tool_artifacts WHERE lower(created_by) LIKE ${`${NS}%`}`
    await sql`DELETE FROM tool_runs WHERE user_email LIKE ${`${NS}%`}`
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

    const rows = await ownRows()
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
    expect(await ownRows()).toHaveLength(1)
  })

  it('a manual Save & Close from the old path (same metadata.deepRunId) counts as already saved', async () => {
    const run = await landedRun(crypto.randomUUID())
    const sql = getSql()
    // sql.json(): the raw postgres-js client JSON.stringify()s any jsonb-typed
    // parameter, so a pre-stringified value would land double-encoded (a JSON
    // string scalar, where ->'metadata' is NULL). The app's drizzle client
    // overrides that serializer, which is why the product path never hits it.
    const manualContent = { toolId: 'deep-research', title: 'manual', sections: [], metadata: { deepRunId: run.id } }
    const [{ id: manualId }] = await sql<{ id: string }[]>`
      INSERT INTO tool_artifacts (tenant_id, tool_id, title, content, created_by)
      VALUES ('rxfit', 'deep-research', 'Deep Research: manual', ${sql.json(manualContent)}::jsonb, ${OWNER})
      RETURNING id
    `
    // Sanity: the seed is a real object in the column, not a quoted string.
    const [{ deep_run_id }] = await sql<{ deep_run_id: string | null }[]>`
      SELECT content->'metadata'->>'deepRunId' AS deep_run_id FROM tool_artifacts WHERE id = ${manualId}
    `
    expect(deep_run_id).toBe(run.id)

    const ensured = await ensureDeepRunArtifact(run, { tenantId: 'rxfit', createdBy: OWNER })
    expect(ensured).toEqual({ id: manualId, title: 'Deep Research: manual', created: false })
  })

  it("another user's row claiming the same run id never blocks the owner's save (dedupe is owner-scoped)", async () => {
    const run = await landedRun(crypto.randomUUID())
    const sql = getSql()
    // metadata.deepRunId is client-writable via POST /api/tool-artifacts —
    // simulate a colleague's row that names this run.
    const [{ id: intruderId }] = await sql<{ id: string }[]>`
      INSERT INTO tool_artifacts (tenant_id, tool_id, title, content, created_by)
      VALUES ('rxfit', 'deep-research', 'not yours', ${sql.json({
        toolId: 'deep-research', title: 'x', sections: [], metadata: { deepRunId: run.id },
      })}::jsonb, ${COLLEAGUE})
      RETURNING id
    `
    const ensured = await ensureDeepRunArtifact(run, { tenantId: 'rxfit', createdBy: OWNER })
    expect(ensured.created).toBe(true)
    expect(ensured.id).not.toBe(intruderId)
    // …and the owner's own row is what dedupes from now on.
    const again = await ensureDeepRunArtifact(run, { tenantId: 'rxfit', createdBy: OWNER })
    expect(again).toEqual({ id: ensured.id, title: ensured.title, created: false })
  })

  it('an archived artifact does not block a fresh save (only active rows count)', async () => {
    const run = await landedRun(crypto.randomUUID())
    const first = await ensureDeepRunArtifact(run, { tenantId: 'rxfit', createdBy: OWNER })
    await getSql()`UPDATE tool_artifacts SET status = 'archived' WHERE id = ${first.id}`
    const again = await ensureDeepRunArtifact(run, { tenantId: 'rxfit', createdBy: OWNER })
    expect(again.created).toBe(true)
    expect(again.id).not.toBe(first.id)
  })

  it('different runs get different artifacts', async () => {
    const a = await landedRun(crypto.randomUUID())
    const b = await landedRun(crypto.randomUUID())
    const ea = await ensureDeepRunArtifact(a, { tenantId: 'rxfit', createdBy: OWNER })
    const eb = await ensureDeepRunArtifact(b, { tenantId: 'rxfit', createdBy: OWNER })
    expect(ea.id).not.toBe(eb.id)
    expect(await ownRows()).toHaveLength(2)
  })

  it('ensure-by-run-id: nothing to save while queued, the artifact once landed, still nothing for the wrong owner', async () => {
    const id = crypto.randomUUID()
    await createToolRun({ id, tool: 'deep-think', brief: 'Decide pricing', userEmail: OWNER })
    expect(await ensureDeepRunArtifactForRun(id, OWNER, 'rxfit')).toBeNull()

    await finishToolRun(db, id, { status: 'succeeded', resultMd: REPORT })
    const saved = await ensureDeepRunArtifactForRun(id, OWNER, 'rxfit')
    expect(saved?.created).toBe(true)
    expect(saved?.title).toBe('Deep Think: Churn drivers')
    expect(await ensureDeepRunArtifactForRun(id, STRANGER, 'rxfit')).toBeNull()

    expect(await ownRows()).toHaveLength(1)
  })

  it('a landing-side save is listed for its owner however the session spells the email', async () => {
    const id = crypto.randomUUID()
    await createToolRun({ id, tool: 'deep-research', brief: 'Why churn?', userEmail: MIXED_CASE })
    await finishToolRun(db, id, { status: 'succeeded', resultMd: REPORT })
    const saved = await ensureDeepRunArtifactForRun(id, MIXED_CASE, 'rxfit')
    expect(saved?.created).toBe(true)

    // tool_runs lowercases the owner; the Artifacts tab scopes staff by their
    // session email, which Google may spell with capitals.
    const mixed = await getToolArtifacts('rxfit', undefined, 20, MIXED_CASE)
    expect(mixed.map(a => a.id)).toEqual([saved!.id])
    const lower = await getToolArtifacts('rxfit', undefined, 20, MIXED_CASE.toLowerCase())
    expect(lower.map(a => a.id)).toEqual([saved!.id])
    const other = await getToolArtifacts('rxfit', undefined, 20, STRANGER)
    expect(other).toEqual([])
  })

  it('a failed run is never saved as an artifact', async () => {
    const id = crypto.randomUUID()
    await createToolRun({ id, tool: 'deep-research', brief: 'b', userEmail: OWNER })
    await finishToolRun(db, id, { status: 'failed', errorClass: 'timeout', error: 'took too long' })
    expect(await ensureDeepRunArtifactForRun(id, OWNER, 'rxfit')).toBeNull()
    expect(await ownRows()).toHaveLength(0)
  })
})
