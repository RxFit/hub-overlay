import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { describeDb, migrateTestDb, getSql, closeDb, seedTenant } from '../test/db-harness'
import {
  cancelJob,
  claimNext,
  deliverResult,
  enqueueJob,
  getJobDetail,
  getJobView,
  heartbeatJob,
  postResult,
  reapExpired,
  upsertWorker,
  workerFresh,
} from '@/lib/dispatch-store'
import {
  cancelToolRun,
  countActiveToolRuns,
  createToolRun,
  getToolRunOwned,
  listToolRuns,
} from '@/lib/tool-runs'

/**
 * dispatch_jobs / dispatch_workers — the Phase 2.5 queue against REAL
 * Postgres (skipped without DATABASE_URL; CI provides one). Locks the
 * multi-instance correctness story:
 *  - SKIP LOCKED claims never double-lease,
 *  - result posting is an idempotent CAS with the four designed outcomes,
 *  - the cancellation race records honestly (discarded_cancelled),
 *  - chat leases never requeue (at-most-once), work_items do,
 *  - content is scrubbed on delivery and on terminal transitions.
 */

describeDb('dispatch store (Postgres)', () => {
  beforeAll(() => {
    migrateTestDb()
  })

  beforeEach(async () => {
    // First suite to use these tables — clean our own rows, leave the shared
    // RESET_TABLES list alone.
    const sql = getSql()
    await sql`DELETE FROM dispatch_jobs`
    await sql`DELETE FROM dispatch_workers`
    await seedTenant()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('enqueue stores provenance (chars + fingerprint) alongside the payload', async () => {
    const out = await enqueueJob({ kind: 'chat_turn', prompt: 'hello world', deadlineMs: 45_000, requestId: 'r1' })
    expect('id' in out).toBe(true)
    const sql = getSql()
    const [row] = await sql`SELECT payload_text, prompt_chars, prompt_sha256, priority, max_attempts FROM dispatch_jobs`
    expect(row.payload_text).toBe('hello world')
    expect(row.prompt_chars).toBe(11)
    expect(row.prompt_sha256).toHaveLength(16)
    expect(row.priority).toBe(0)
    expect(row.max_attempts).toBe(1)
  })

  it('claims lease the job exactly once — a second claim finds nothing', async () => {
    await enqueueJob({ kind: 'chat_turn', prompt: 'p', deadlineMs: 45_000 })
    const first = await claimNext('w1', ['chat_turn'])
    const second = await claimNext('w2', ['chat_turn'])
    expect(first?.payloadText).toBe('p')
    expect(first?.attempt).toBe(1)
    expect(second).toBeNull()
  })

  it('claim orders chat (priority 0) before work_item (priority 100)', async () => {
    await enqueueJob({ kind: 'work_item', prompt: 'slow', deadlineMs: 600_000 })
    await enqueueJob({ kind: 'chat_turn', prompt: 'fast', deadlineMs: 45_000 })
    const job = await claimNext('w1', ['chat_turn', 'work_item'])
    expect(job?.kind).toBe('chat_turn')
  })

  it('backpressure: the fourth active chat_turn is refused', async () => {
    for (let i = 0; i < 3; i++) {
      const out = await enqueueJob({ kind: 'chat_turn', prompt: `p${i}`, deadlineMs: 45_000 })
      expect('id' in out).toBe(true)
    }
    const fourth = await enqueueJob({ kind: 'chat_turn', prompt: 'p3', deadlineMs: 45_000 })
    expect(fourth).toEqual({ refused: 'queue_full' })
  })

  it('result CAS: recorded once, duplicate on retry, no state change', async () => {
    const out = await enqueueJob({ kind: 'chat_turn', prompt: 'p', deadlineMs: 45_000 })
    const id = (out as { id: string }).id
    const job = await claimNext('w1', ['chat_turn'])
    expect(job?.id).toBe(id)
    const post = { status: 'ok' as const, text: 'answer', workerId: 'w1', attempt: 1, latencyMs: 900 }
    const first = await postResult(id, post)
    expect(first.outcome).toBe('recorded')
    const retry = await postResult(id, post)
    expect(retry.outcome).toBe('duplicate')
    const view = await getJobView(id)
    expect(view?.state).toBe('succeeded')
  })

  it('the cancellation race: cancel-while-leased ⇒ discarded_cancelled, text never stored', async () => {
    const out = await enqueueJob({ kind: 'chat_turn', prompt: 'p', deadlineMs: 45_000 })
    const id = (out as { id: string }).id
    await claimNext('w1', ['chat_turn'])
    await cancelJob(id) // leased ⇒ sets cancel_requested_at
    const hb = await heartbeatJob(id, 'w1', 1)
    expect(hb).toEqual({ ok: true, cancelRequested: true }) // pull-based cancel delivery
    const posted = await postResult(id, { status: 'ok', text: 'too late', workerId: 'w1', attempt: 1 })
    expect(posted.outcome).toBe('discarded_cancelled')
    const sql = getSql()
    const [row] = await sql`SELECT state, result_text, payload_text, scrubbed_at FROM dispatch_jobs WHERE id = ${id}`
    expect(row.state).toBe('cancelled')
    expect(row.result_text).toBeNull()
    expect(row.payload_text).toBeNull()
    expect(row.scrubbed_at).not.toBeNull()
  })

  it('cancel of a still-queued job is immediate and scrubs the prompt', async () => {
    const out = await enqueueJob({ kind: 'chat_turn', prompt: 'p', deadlineMs: 45_000 })
    const id = (out as { id: string }).id
    await cancelJob(id)
    const view = await getJobView(id)
    expect(view?.state).toBe('cancelled')
    expect(await claimNext('w1', ['chat_turn'])).toBeNull()
  })

  it('delivery returns the text once and scrubs content in the same transaction', async () => {
    const out = await enqueueJob({ kind: 'chat_turn', prompt: 'p', deadlineMs: 45_000 })
    const id = (out as { id: string }).id
    await claimNext('w1', ['chat_turn'])
    await postResult(id, { status: 'ok', text: 'the answer', workerId: 'w1', attempt: 1 })
    const delivered = await deliverResult(id)
    expect(delivered?.text).toBe('the answer')
    expect(await deliverResult(id)).toBeNull() // once only
    const sql = getSql()
    const [row] = await sql`SELECT result_text, delivered_at, scrubbed_at FROM dispatch_jobs WHERE id = ${id}`
    expect(row.result_text).toBeNull()
    expect(row.delivered_at).not.toBeNull()
    expect(row.scrubbed_at).not.toBeNull()
  })

  it('a lapsed chat lease expires terminally (at-most-once) — never requeues', async () => {
    const out = await enqueueJob({ kind: 'chat_turn', prompt: 'p', deadlineMs: 45_000 })
    const id = (out as { id: string }).id
    await claimNext('w1', ['chat_turn'])
    const sql = getSql()
    await sql`UPDATE dispatch_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${id}`
    await reapExpired()
    const view = await getJobView(id)
    expect(view?.state).toBe('expired')
    expect(view?.errorClass).toBe('lease_expired')
    expect(await claimNext('w1', ['chat_turn'])).toBeNull()
  })

  it('a lapsed work_item lease requeues with the attempt preserved', async () => {
    const out = await enqueueJob({ kind: 'work_item', prompt: 'p', deadlineMs: 600_000 })
    const id = (out as { id: string }).id
    await claimNext('w1', ['work_item'])
    const sql = getSql()
    await sql`UPDATE dispatch_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${id}`
    await reapExpired()
    const reclaimed = await claimNext('w1', ['work_item'])
    expect(reclaimed?.id).toBe(id)
    expect(reclaimed?.attempt).toBe(2)
  })

  it('a late post after lease loss lands as discarded_lease_lost', async () => {
    const out = await enqueueJob({ kind: 'work_item', prompt: 'p', deadlineMs: 600_000 })
    const id = (out as { id: string }).id
    await claimNext('w1', ['work_item'])
    const sql = getSql()
    await sql`UPDATE dispatch_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${id}`
    await reapExpired() // requeued for attempt 2
    const late = await postResult(id, { status: 'ok', text: 'zombie', workerId: 'w1', attempt: 1 })
    expect(late.outcome).toBe('discarded_lease_lost')
  })

  it('heartbeat guard fails with lease_lost for a stranger or stale attempt', async () => {
    const out = await enqueueJob({ kind: 'chat_turn', prompt: 'p', deadlineMs: 45_000 })
    const id = (out as { id: string }).id
    await claimNext('w1', ['chat_turn'])
    expect(await heartbeatJob(id, 'w2', 1)).toEqual({ ok: false, reason: 'lease_lost' })
    expect(await heartbeatJob(id, 'w1', 2)).toEqual({ ok: false, reason: 'lease_lost' })
    expect(await heartbeatJob(id, 'w1', 1)).toEqual({ ok: true, cancelRequested: false })
  })

  it('worker liveness: fresh after upsert, stale after the window', async () => {
    expect(await workerFresh(45_000)).toBe(false)
    await upsertWorker('danny-desktop', { version: 'abc123' })
    expect(await workerFresh(45_000)).toBe(true)
    const sql = getSql()
    await sql`UPDATE dispatch_workers SET last_seen_at = now() - interval '2 minutes'`
    expect(await workerFresh(45_000)).toBe(false)
  })

  it('SKIP LOCKED under real contention: a row locked by another transaction is skipped, not blocked on', async () => {
    await enqueueJob({ kind: 'chat_turn', prompt: 'p', deadlineMs: 45_000 })
    const sql = getSql()
    // Hold the only queued row under FOR UPDATE in a second connection's open
    // transaction — a concurrent claim must return null promptly (SKIP LOCKED)
    // instead of blocking until the lock releases or double-leasing.
    await sql.begin(async (tx) => {
      const locked = await tx`SELECT id FROM dispatch_jobs WHERE state = 'queued' FOR UPDATE`
      expect(locked).toHaveLength(1)
      const start = Date.now()
      const claimed = await claimNext('w1', ['chat_turn'])
      expect(claimed).toBeNull()
      expect(Date.now() - start).toBeLessThan(2_000) // skipped, not waited out
    })
    // Lock released — the claim now succeeds.
    const after = await claimNext('w1', ['chat_turn'])
    expect(after?.payloadText).toBe('p')
  })

  it('a cancelled-then-lapsed work_item goes terminal cancelled — never requeued with a stale flag', async () => {
    const out = await enqueueJob({ kind: 'work_item', prompt: 'p', deadlineMs: 600_000 })
    const id = (out as { id: string }).id
    await claimNext('w1', ['work_item'])
    await cancelJob(id) // leased ⇒ cancel_requested_at set
    const sql = getSql()
    await sql`UPDATE dispatch_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${id}`
    await reapExpired()
    const view = await getJobView(id)
    expect(view?.state).toBe('cancelled')
    expect(await claimNext('w2', ['work_item'])).toBeNull()
    const [row] = await sql`SELECT payload_text, scrubbed_at FROM dispatch_jobs WHERE id = ${id}`
    expect(row.payload_text).toBeNull()
    expect(row.scrubbed_at).not.toBeNull()
  })

  it('unclaimed jobs past their deadline expire on reap and are never handed out', async () => {
    const out = await enqueueJob({ kind: 'chat_turn', prompt: 'p', deadlineMs: 45_000 })
    const id = (out as { id: string }).id
    const sql = getSql()
    await sql`UPDATE dispatch_jobs SET deadline_at = now() - interval '1 second' WHERE id = ${id}`
    expect(await claimNext('w1', ['chat_turn'])).toBeNull() // claim filters deadline
    await reapExpired()
    const view = await getJobView(id)
    expect(view?.state).toBe('expired')
    expect(view?.errorClass).toBe('deadline')
  })

  /* ── Deep lane (PR A): reaped work_items leave a ledger row ──────────────
     Phase 3 §7: "reapExpired() never writes a ledger row, so an expired work
     item vanishes without a trace in ai_runs." These lock the fix. ai_runs
     assertions filter by meta jobId (a uuid), so shared-table residue from
     other suites can never collide. */

  async function aiRunsForJob(id: string) {
    const sql = getSql()
    return sql`SELECT source, status, error_class, prompt_chars, prompt_sha256, meta FROM ai_runs WHERE meta->>'jobId' = ${id}`
  }

  it('a work_item that exhausts its attempts is ledgered as lease_expired with fingerprint provenance', async () => {
    const out = await enqueueJob({ kind: 'work_item', prompt: 'deep brief', deadlineMs: 600_000, meta: { toolRunId: crypto.randomUUID() } })
    const id = (out as { id: string }).id
    const sql = getSql()
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = await claimNext('w1', ['work_item'])
      expect(job?.attempt).toBe(attempt)
      await sql`UPDATE dispatch_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${id}`
      await reapExpired()
    }
    const view = await getJobView(id)
    expect(view?.state).toBe('expired')
    const rows = await aiRunsForJob(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('tool') // toolRunId in payload_meta drives the source
    expect(rows[0].status).toBe('error')
    expect(rows[0].error_class).toBe('lease_expired')
    expect(rows[0].prompt_chars).toBe('deep brief'.length) // provenance survives the scrub
    expect(rows[0].prompt_sha256).toHaveLength(16)
    expect(rows[0].meta.reap).toBe(true)
  })

  it('an unclaimed work_item past its deadline is ledgered as deadline', async () => {
    const out = await enqueueJob({ kind: 'work_item', prompt: 'p', deadlineMs: 600_000, meta: { probe: true, marker: 'm' } })
    const id = (out as { id: string }).id
    const sql = getSql()
    await sql`UPDATE dispatch_jobs SET deadline_at = now() - interval '1 second' WHERE id = ${id}`
    await reapExpired()
    const rows = await aiRunsForJob(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('work_probe')
    expect(rows[0].error_class).toBe('deadline')
  })

  it('reap ledgers NOTHING for chat_turn expiries — the waiting reader already did', async () => {
    const out = await enqueueJob({ kind: 'chat_turn', prompt: 'p', deadlineMs: 45_000 })
    const id = (out as { id: string }).id
    await claimNext('w1', ['chat_turn'])
    const sql = getSql()
    await sql`UPDATE dispatch_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${id}`
    await reapExpired()
    expect(await aiRunsForJob(id)).toHaveLength(0)
  })

  it('a requeued work_item (attempts left) is NOT ledgered — only terminal states are', async () => {
    const out = await enqueueJob({ kind: 'work_item', prompt: 'p', deadlineMs: 600_000 })
    const id = (out as { id: string }).id
    await claimNext('w1', ['work_item'])
    const sql = getSql()
    await sql`UPDATE dispatch_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${id}`
    await reapExpired() // → back to queued, attempt 1 of 3 spent
    expect((await getJobView(id))?.state).toBe('queued')
    expect(await aiRunsForJob(id)).toHaveLength(0)
  })

  it('postResult surfaces kind and payload_meta so the route can label sources per job', async () => {
    const trId = crypto.randomUUID()
    const out = await enqueueJob({ kind: 'work_item', prompt: 'p', deadlineMs: 600_000, meta: { toolRunId: trId } })
    const id = (out as { id: string }).id
    await claimNext('w1', ['work_item'])
    const posted = await postResult(id, { status: 'ok', text: 'report', workerId: 'w1', attempt: 1 })
    expect(posted.outcome).toBe('recorded')
    if (posted.outcome === 'recorded') {
      expect(posted.kind).toBe('work_item')
      expect(posted.payloadMeta).toMatchObject({ toolRunId: trId })
    }
  })

  it('a malformed toolRunId in payload_meta degrades to "no tool run" — result posting never breaks on it', async () => {
    const out = await enqueueJob({ kind: 'work_item', prompt: 'p', deadlineMs: 600_000, meta: { toolRunId: 'not-a-uuid' } })
    const id = (out as { id: string }).id
    await claimNext('w1', ['work_item'])
    const posted = await postResult(id, { status: 'ok', text: 'report', workerId: 'w1', attempt: 1 })
    expect(posted.outcome).toBe('recorded')
    if (posted.outcome === 'recorded') {
      expect(posted.toolRun).toBeNull() // garbage id ⇒ nothing to land, no thrown transaction
    }
  })

  it('getJobDetail exposes meta and timing but never payload or result text', async () => {
    const out = await enqueueJob({ kind: 'work_item', prompt: 'secret brief', deadlineMs: 600_000, meta: { probe: true } })
    const id = (out as { id: string }).id
    const detail = await getJobDetail(id)
    expect(detail?.kind).toBe('work_item')
    expect(detail?.maxAttempts).toBe(3)
    expect(detail?.payloadMeta).toMatchObject({ probe: true })
    expect(JSON.stringify(detail)).not.toContain('secret brief')
  })
})

/**
 * Deep runs (PR B, DEEP_LANE_2026-08-23.md §4) — the tool_runs landing
 * contract, in THIS file deliberately: vitest runs test files in parallel
 * workers against the one shared CI Postgres, and these tests truncate the
 * same dispatch tables as the suite above. Same file ⇒ same worker ⇒
 * sequential ⇒ no cross-suite clobbering. Locks:
 *  - a worker result lands the report into tool_runs IN THE SAME transaction
 *    as the queue's terminal transition, with the queue row scrubbed +
 *    delivered at once (no orphan-sweep double-ledger bait),
 *  - failures and reaped runs go terminal in tool_runs — a deep run never
 *    simply vanishes,
 *  - user cancel wins its race exactly once (guarded CAS from 'queued'),
 *  - reads are owner-scoped at the store layer.
 */
describeDb('deep runs — tool_runs landing (Postgres)', () => {
  const OWNER = 'staff@rxfitatx.com'

  beforeAll(() => {
    migrateTestDb()
  })

  beforeEach(async () => {
    const sql = getSql()
    await sql`DELETE FROM dispatch_jobs`
    await sql`DELETE FROM dispatch_workers`
    await sql`DELETE FROM tool_runs`
    await seedTenant()
  })

  async function startRun(tool = 'deep-research', brief = 'why is churn rising'): Promise<{ runId: string; jobId: string }> {
    const runId = crypto.randomUUID()
    const out = await enqueueJob({
      kind: 'work_item',
      prompt: `protocol…\n# The brief\n${brief}`,
      deadlineMs: 600_000,
      meta: { toolRunId: runId, tool, userEmail: OWNER },
    })
    const jobId = (out as { id: string }).id
    await createToolRun({ id: runId, tool, brief, userEmail: OWNER, jobId })
    return { runId, jobId }
  }

  it('a successful worker result lands the report durably and scrubs the queue row in one transaction', async () => {
    const { runId, jobId } = await startRun()
    await claimNext('w1', ['work_item'])
    const posted = await postResult(jobId, {
      status: 'ok',
      text: '# Report\nAnswer.\n```json\n{"title":"t"}\n```',
      model: 'gemini-3',
      usage: { outputTokens: 1200 },
      workerId: 'w1',
      attempt: 1,
      latencyMs: 65_000,
    })
    expect(posted.outcome).toBe('recorded')
    if (posted.outcome === 'recorded') {
      expect(posted.toolRun).toMatchObject({ id: runId, tool: 'deep-research', userEmail: OWNER })
    }

    const run = await getToolRunOwned(runId, OWNER)
    expect(run?.status).toBe('succeeded')
    expect(run?.resultMd).toContain('# Report')
    expect(run?.model).toBe('gemini-3')
    expect(run?.attempt).toBe(1)

    // The queue row holds no content and cannot bait the orphan sweep:
    // delivered+scrubbed the instant the durable copy landed.
    const sql = getSql()
    const [job] = await sql`SELECT result_text, payload_text, delivered_at, scrubbed_at, state FROM dispatch_jobs WHERE id = ${jobId}`
    expect(job.state).toBe('succeeded')
    expect(job.result_text).toBeNull()
    expect(job.payload_text).toBeNull()
    expect(job.delivered_at).not.toBeNull()
    expect(job.scrubbed_at).not.toBeNull()
  })

  it('a worker error goes terminal failed with the typed class', async () => {
    const { runId, jobId } = await startRun()
    await claimNext('w1', ['work_item'])
    await postResult(jobId, { status: 'error', errorClass: 'timeout', error: 'run exceeded budget', workerId: 'w1', attempt: 1 })
    const run = await getToolRunOwned(runId, OWNER)
    expect(run?.status).toBe('failed')
    expect(run?.errorClass).toBe('timeout')
    expect(run?.resultMd).toBeNull()
  })

  it('a run whose job exhausts all attempts is failed by the reaper — it never vanishes', async () => {
    const { runId, jobId } = await startRun()
    const sql = getSql()
    for (let attempt = 1; attempt <= 3; attempt++) {
      await claimNext('w1', ['work_item'])
      await sql`UPDATE dispatch_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${jobId}`
      await reapExpired()
    }
    const run = await getToolRunOwned(runId, OWNER)
    expect(run?.status).toBe('failed')
    expect(run?.errorClass).toBe('lease_expired')
  })

  it('user cancel goes terminal immediately; the worker result that raced it is discarded and cannot overwrite', async () => {
    const { runId, jobId } = await startRun()
    await claimNext('w1', ['work_item'])
    const cancelledJobId = await cancelToolRun(runId, OWNER)
    expect(cancelledJobId).toBe(jobId)
    await cancelJob(jobId)

    // The worker finishes anyway and posts late.
    const late = await postResult(jobId, { status: 'ok', text: 'too late', workerId: 'w1', attempt: 1 })
    expect(late.outcome).toBe('discarded_cancelled')
    if (late.outcome === 'discarded_cancelled') {
      expect(late.toolRun).toBeNull() // CAS from 'queued' found 'cancelled' — no overwrite
    }
    const run = await getToolRunOwned(runId, OWNER)
    expect(run?.status).toBe('cancelled')
    expect(run?.resultMd).toBeNull()
  })

  it('cancel is owner-scoped and single-shot', async () => {
    const { runId } = await startRun()
    expect(await cancelToolRun(runId, 'other@rxfitatx.com')).toBeNull()
    expect((await getToolRunOwned(runId, OWNER))?.status).toBe('queued')
    expect(await cancelToolRun(runId, OWNER)).not.toBeNull()
    expect(await cancelToolRun(runId, OWNER)).toBeNull() // already terminal
  })

  it('reads are owner-scoped and the active cap counts only live queued runs', async () => {
    const { runId } = await startRun()
    expect(await getToolRunOwned(runId, 'other@rxfitatx.com')).toBeNull()
    expect(await listToolRuns('other@rxfitatx.com', { limit: 10 })).toHaveLength(0)
    expect(await countActiveToolRuns(OWNER)).toBe(1)

    // A stale queued row (zombie) ages out of the cap window.
    const sql = getSql()
    await sql`UPDATE tool_runs SET created_at = now() - interval '2 hours' WHERE id = ${runId}`
    expect(await countActiveToolRuns(OWNER)).toBe(0)
  })
})
