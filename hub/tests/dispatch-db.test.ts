import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { describeDb, migrateTestDb, getSql, closeDb, seedTenant } from '../test/db-harness'
import {
  cancelJob,
  claimNext,
  deliverResult,
  enqueueJob,
  getJobView,
  heartbeatJob,
  postResult,
  reapExpired,
  upsertWorker,
  workerFresh,
} from '@/lib/dispatch-store'

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
})
