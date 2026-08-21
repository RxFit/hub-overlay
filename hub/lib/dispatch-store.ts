import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import { db, withTransaction } from '@/lib/db'
import { dispatchJobs, dispatchWorkers } from '@/lib/schema'
import { fingerprintPrompt, recordAiRun } from '@/lib/runs'

/**
 * lib/dispatch-store.ts — the Postgres data layer of desktop dispatch
 * (Phase 2.5, docs/architecture/DESKTOP_DISPATCH_2026-08-15.md).
 *
 * All queue SQL lives here so lib/agy-dispatch.ts (Hub-side orchestration)
 * and the /api/worker/* routes stay logic-only and unit-testable by mocking
 * this one module. Invariants owned here:
 *
 *  - Every state transition is a guarded compare-and-set (WHERE state=…,
 *    plus leased_by/attempt where relevant) — no unguarded writes to state.
 *  - Claims use FOR UPDATE SKIP LOCKED inside a transaction, so double-claim
 *    is impossible across Hub instances and across future multiple workers.
 *  - Content (payload_text/result_text) is transient: nulled in the same
 *    UPDATE that delivers or terminates; prompt_chars/prompt_sha256 survive.
 *    ai_runs stays the only long-lived record.
 *  - Callers own error policy: the Hub path treats any store failure
 *    (including 42P01 missing table — migrations are non-fatal by contract)
 *    as "dispatch unavailable", the worker routes return 503.
 */

export type DispatchKind = 'chat_turn' | 'work_item'

export const KIND_POLICY: Record<DispatchKind, {
  priority: number
  maxAttempts: number
  leaseMs: number
  heartbeatMs: number
}> = {
  // At-most-once: a lapsed chat lease is never re-run — the turn already fell
  // back to metered, and a rerun would spend allotment nobody reads.
  chat_turn: { priority: 0, maxAttempts: 1, leaseMs: 25_000, heartbeatMs: 10_000 },
  // At-least-once: re-execution converges via job-scoped idempotency
  // (job id in the branch name + fetch-first), not queue magic.
  work_item: { priority: 100, maxAttempts: 3, leaseMs: 180_000, heartbeatMs: 30_000 },
}

/** One per possible concurrent instance-held request — the honest capacity of
 *  a single serial desktop. Enqueue beyond it refuses (⇒ metered fallthrough). */
const MAX_ACTIVE_CHAT = 3
const MAX_QUEUED_WORK = 10

const CONTENT_TTL_MS = 10 * 60_000       // scrub safety net for undelivered content
const ROW_TTL_DAYS = 7                   // hard-delete window; ai_runs is the durable record

export function isMissingTableError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '42P01'
}

/* ── Hub side: enqueue / watch / deliver / cancel ────────────────────────── */

export interface EnqueueInput {
  kind: DispatchKind
  prompt: string
  meta?: Record<string, unknown>
  deadlineMs: number
  requestId?: string
}

export type EnqueueOutcome = { id: string } | { refused: 'queue_full' }

export async function enqueueJob(input: EnqueueInput): Promise<EnqueueOutcome> {
  const policy = KIND_POLICY[input.kind]
  const active = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(dispatchJobs)
    .where(and(inArray(dispatchJobs.state, ['queued', 'leased']), eq(dispatchJobs.kind, input.kind)))
  const cap = input.kind === 'chat_turn' ? MAX_ACTIVE_CHAT : MAX_QUEUED_WORK
  if ((active[0]?.n ?? 0) >= cap) return { refused: 'queue_full' }

  const rows = await db
    .insert(dispatchJobs)
    .values({
      kind: input.kind,
      priority: policy.priority,
      maxAttempts: policy.maxAttempts,
      deadlineAt: new Date(Date.now() + input.deadlineMs),
      payloadText: input.prompt,
      payloadMeta: input.meta,
      promptChars: input.prompt.length,
      promptSha256: fingerprintPrompt(input.prompt),
      requestId: input.requestId,
    })
    .returning({ id: dispatchJobs.id })

  // Probabilistic safety-net sweep, piggybacked so no cron is needed.
  if (Math.random() < 0.05) void sweepStale().catch(() => {})

  return { id: rows[0].id }
}

export interface JobView {
  state: string
  leaseExpiresAt: Date | null
  errorClass: string | null
  error: string | null
}

export async function getJobView(id: string): Promise<JobView | null> {
  const rows = await db
    .select({
      state: dispatchJobs.state,
      leaseExpiresAt: dispatchJobs.leaseExpiresAt,
      errorClass: dispatchJobs.errorClass,
      error: dispatchJobs.error,
    })
    .from(dispatchJobs)
    .where(eq(dispatchJobs.id, id))
    .limit(1)
  return rows[0] ?? null
}

export interface DeliveredResult {
  text: string
  resultMeta: Record<string, unknown> | null
}

/**
 * Read a succeeded job's result and scrub content in the same transaction —
 * content lifetime on the happy path is seconds. Null when the row is not in
 * a deliverable state (already delivered, or never succeeded).
 */
export async function deliverResult(id: string): Promise<DeliveredResult | null> {
  return withTransaction(async (tx) => {
    const rows = await tx
      .select({ text: dispatchJobs.resultText, resultMeta: dispatchJobs.resultMeta })
      .from(dispatchJobs)
      .where(and(eq(dispatchJobs.id, id), eq(dispatchJobs.state, 'succeeded'), sql`delivered_at IS NULL`))
      .limit(1)
      .for('update')
    const row = rows[0]
    if (!row || row.text === null) return null
    await tx
      .update(dispatchJobs)
      .set({
        deliveredAt: new Date(),
        payloadText: null,
        resultText: null,
        scrubbedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(dispatchJobs.id, id))
    return { text: row.text, resultMeta: row.resultMeta ?? null }
  })
}

/**
 * Hub gives up on a job (fallback fired, budget spent, or client aborted).
 * queued → cancelled immediately; leased → cancel_requested_at (the worker
 * learns via its next heartbeat and stands down; its late result posts as
 * discarded_cancelled). Both guarded; no-ops if the state already moved on.
 */
export async function cancelJob(id: string): Promise<void> {
  await db
    .update(dispatchJobs)
    .set({
      state: 'cancelled',
      finishedAt: new Date(),
      payloadText: null,
      resultText: null,
      scrubbedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(dispatchJobs.id, id), eq(dispatchJobs.state, 'queued')))
  await db
    .update(dispatchJobs)
    .set({ cancelRequestedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(dispatchJobs.id, id), eq(dispatchJobs.state, 'leased'), sql`cancel_requested_at IS NULL`))
}

/** The ~5ms liveness gate: is ANY worker fresh enough to bother enqueueing? */
export async function workerFresh(freshMs: number): Promise<boolean> {
  const rows = await db
    .select({ id: dispatchWorkers.id })
    .from(dispatchWorkers)
    .where(gt(dispatchWorkers.lastSeenAt, new Date(Date.now() - freshMs)))
    .limit(1)
  return rows.length > 0
}

/* ── Worker side: claim / heartbeat / result ─────────────────────────────── */

export interface ClaimedJob {
  id: string
  kind: DispatchKind
  attempt: number
  payloadText: string | null
  payloadMeta: Record<string, unknown> | null
  createdAt: Date
  deadlineAt: Date
  leaseExpiresAt: Date
  heartbeatMs: number
}

export async function upsertWorker(id: string, info: { version?: string; agyVersion?: string }): Promise<void> {
  await db
    .insert(dispatchWorkers)
    .values({ id, version: info.version, agyVersion: info.agyVersion })
    .onConflictDoUpdate({
      target: dispatchWorkers.id,
      set: { lastSeenAt: new Date(), version: info.version, agyVersion: info.agyVersion },
    })
}

/**
 * Lazy reaper — piggybacked on claims and on dispatch-health, never a cron.
 * The chat wait-loop does NOT depend on this: it fails fast on
 * lease_expires_at itself, so user latency never waits for a reap.
 */
export interface ReapCounts {
  cancelled: number
  requeued: number
  leaseExpired: number
  deadlineExpired: number
}

export async function reapExpired(): Promise<ReapCounts> {
  const now = new Date()
  // A cancelled-then-lapsed lease goes terminal, never back into the queue:
  // the Hub already gave up on the job, and requeueing it would either burn
  // an attempt on work nobody wants or poison the next claim with a stale
  // cancel flag (the fresh worker's first heartbeat would tell it to abort).
  const cancelled = await db
    .update(dispatchJobs)
    .set({
      state: 'cancelled',
      finishedAt: now,
      payloadText: null,
      resultText: null,
      scrubbedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(dispatchJobs.state, 'leased'),
      lt(dispatchJobs.leaseExpiresAt, now),
      sql`cancel_requested_at IS NOT NULL`,
    ))
    .returning({ id: dispatchJobs.id })
  // Lapsed work_item leases with attempts left → back to queued.
  const requeued = await db
    .update(dispatchJobs)
    .set({ state: 'queued', leasedBy: null, leaseExpiresAt: null, updatedAt: now })
    .where(and(
      eq(dispatchJobs.state, 'leased'),
      lt(dispatchJobs.leaseExpiresAt, now),
      eq(dispatchJobs.kind, 'work_item'),
      sql`attempt < max_attempts`,
    ))
    .returning({ id: dispatchJobs.id })
  // Lapsed chat leases (at-most-once) and spent work_items → terminal expired.
  const leaseExpired = await db
    .update(dispatchJobs)
    .set({
      state: 'expired',
      errorClass: 'lease_expired',
      finishedAt: now,
      payloadText: null,
      resultText: null,
      scrubbedAt: now,
      updatedAt: now,
    })
    .where(and(eq(dispatchJobs.state, 'leased'), lt(dispatchJobs.leaseExpiresAt, now)))
    .returning({ id: dispatchJobs.id })
  // Unclaimed jobs past their deadline: executing them is pointless.
  const deadlineExpired = await db
    .update(dispatchJobs)
    .set({
      state: 'expired',
      errorClass: 'deadline',
      finishedAt: now,
      payloadText: null,
      resultText: null,
      scrubbedAt: now,
      updatedAt: now,
    })
    .where(and(eq(dispatchJobs.state, 'queued'), lt(dispatchJobs.deadlineAt, now)))
    .returning({ id: dispatchJobs.id })
  return {
    cancelled: cancelled.length,
    requeued: requeued.length,
    leaseExpired: leaseExpired.length,
    deadlineExpired: deadlineExpired.length,
  }
}

export async function claimNext(workerId: string, kinds: DispatchKind[]): Promise<ClaimedJob | null> {
  return withTransaction(async (tx) => {
    const picked = await tx
      .select({ id: dispatchJobs.id, kind: dispatchJobs.kind })
      .from(dispatchJobs)
      .where(and(
        eq(dispatchJobs.state, 'queued'),
        gt(dispatchJobs.deadlineAt, new Date()),
        inArray(dispatchJobs.kind, kinds),
      ))
      .orderBy(asc(dispatchJobs.priority), asc(dispatchJobs.createdAt))
      .limit(1)
      .for('update', { skipLocked: true })
    const hit = picked[0]
    if (!hit) return null
    const policy = KIND_POLICY[hit.kind as DispatchKind] ?? KIND_POLICY.work_item
    const rows = await tx
      .update(dispatchJobs)
      .set({
        state: 'leased',
        leasedBy: workerId,
        leasedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + policy.leaseMs),
        attempt: sql`attempt + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(dispatchJobs.id, hit.id), eq(dispatchJobs.state, 'queued')))
      .returning({
        id: dispatchJobs.id,
        kind: dispatchJobs.kind,
        attempt: dispatchJobs.attempt,
        payloadText: dispatchJobs.payloadText,
        payloadMeta: dispatchJobs.payloadMeta,
        createdAt: dispatchJobs.createdAt,
        deadlineAt: dispatchJobs.deadlineAt,
        leaseExpiresAt: dispatchJobs.leaseExpiresAt,
      })
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      kind: row.kind as DispatchKind,
      attempt: row.attempt,
      payloadText: row.payloadText,
      payloadMeta: row.payloadMeta ?? null,
      createdAt: row.createdAt,
      deadlineAt: row.deadlineAt,
      leaseExpiresAt: row.leaseExpiresAt as Date,
      heartbeatMs: policy.heartbeatMs,
    }
  })
}

export type HeartbeatOutcome =
  | { ok: true; cancelRequested: boolean }
  | { ok: false; reason: 'lease_lost' }

export async function heartbeatJob(id: string, workerId: string, attempt: number): Promise<HeartbeatOutcome> {
  const rows = await db
    .update(dispatchJobs)
    .set({
      leaseExpiresAt: sql`now() + make_interval(secs => CASE WHEN kind = 'chat_turn' THEN 25 ELSE 180 END)`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(dispatchJobs.id, id),
      eq(dispatchJobs.state, 'leased'),
      eq(dispatchJobs.leasedBy, workerId),
      eq(dispatchJobs.attempt, attempt),
    ))
    .returning({ cancelRequestedAt: dispatchJobs.cancelRequestedAt })
  const row = rows[0]
  if (!row) return { ok: false, reason: 'lease_lost' }
  return { ok: true, cancelRequested: row.cancelRequestedAt !== null }
}

export interface ResultPost {
  status: 'ok' | 'error'
  text?: string
  model?: string
  usage?: Record<string, unknown>
  errorClass?: string
  error?: string
  latencyMs?: number
  workerId: string
  attempt: number
}

export type ResultOutcome =
  | { outcome: 'recorded'; prompt: string | null; requestId: string | null }
  | { outcome: 'discarded_cancelled'; prompt: string | null; requestId: string | null }
  | { outcome: 'discarded_lease_lost' }
  | { outcome: 'duplicate' }
  | { outcome: 'not_found' }

/**
 * The idempotent result CAS. Exactly one caller wins the terminal transition;
 * a network-retried POST lands as 'duplicate' (byte-identical ack, and the
 * route writes no second ledger row). The pre-scrub prompt rides back so the
 * route can fingerprint a ledger row for discarded outcomes.
 */
export async function postResult(id: string, post: ResultPost): Promise<ResultOutcome> {
  return withTransaction(async (tx) => {
    const rows = await tx
      .select({
        state: dispatchJobs.state,
        leasedBy: dispatchJobs.leasedBy,
        attempt: dispatchJobs.attempt,
        cancelRequestedAt: dispatchJobs.cancelRequestedAt,
        payloadText: dispatchJobs.payloadText,
        requestId: dispatchJobs.requestId,
      })
      .from(dispatchJobs)
      .where(eq(dispatchJobs.id, id))
      .limit(1)
      .for('update')
    const row = rows[0]
    if (!row) return { outcome: 'not_found' }

    const mine = row.leasedBy === post.workerId && row.attempt === post.attempt
    if (row.state !== 'leased') {
      return mine && ['succeeded', 'failed', 'cancelled'].includes(row.state)
        ? { outcome: 'duplicate' }
        : { outcome: 'discarded_lease_lost' }
    }
    if (!mine) return { outcome: 'discarded_lease_lost' }

    const now = new Date()
    const resultMeta = {
      model: post.model,
      usage: post.usage,
      workerId: post.workerId,
      latencyMs: post.latencyMs,
    }
    if (row.cancelRequestedAt !== null) {
      // Hub already fell back; the answer has no reader. Record the terminal
      // state (and let the route ledger the spend) but never store the text.
      await tx
        .update(dispatchJobs)
        .set({
          state: 'cancelled',
          resultMeta,
          errorClass: post.errorClass,
          error: post.error,
          latencyMs: post.latencyMs,
          finishedAt: now,
          payloadText: null,
          resultText: null,
          scrubbedAt: now,
          updatedAt: now,
        })
        .where(eq(dispatchJobs.id, id))
      return { outcome: 'discarded_cancelled', prompt: row.payloadText, requestId: row.requestId }
    }
    if (post.status === 'ok') {
      await tx
        .update(dispatchJobs)
        .set({
          state: 'succeeded',
          resultText: post.text ?? '',
          resultMeta,
          latencyMs: post.latencyMs,
          finishedAt: now,
          payloadText: null, // prompt no longer needed once executed
          updatedAt: now,
        })
        .where(eq(dispatchJobs.id, id))
    } else {
      await tx
        .update(dispatchJobs)
        .set({
          state: 'failed',
          resultMeta,
          errorClass: post.errorClass ?? 'unknown',
          error: post.error,
          latencyMs: post.latencyMs,
          finishedAt: now,
          payloadText: null,
          resultText: null,
          scrubbedAt: now,
          updatedAt: now,
        })
        .where(eq(dispatchJobs.id, id))
    }
    return { outcome: 'recorded', prompt: row.payloadText, requestId: row.requestId }
  })
}

/* ── Hygiene + admin visibility ──────────────────────────────────────────── */

export async function sweepStale(): Promise<void> {
  // Serialized by a transaction-scoped advisory lock: the sweep is invoked
  // probabilistically from enqueue, from dispatch-health GETs, and hourly by
  // the alert tick — two sweeps interleaving between the orphan SELECT and
  // the scrub UPDATE would each ledger the same undelivered spend. try-lock,
  // not wait: a sweep that finds the lock held simply defers to the holder.
  await withTransaction(async (tx) => {
    const lock = (await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtext('dispatch_sweep')) AS locked`,
    )) as unknown as Array<{ locked: boolean }>
    if (!lock[0]?.locked) return

    const now = new Date()
    // Failure mode "Hub instance dies mid-wait": the worker's result posted as
    // 'recorded', but the ai_runs row the waiting request would have written is
    // gone with the instance. Before scrubbing such rows, ledger the spend —
    // §7 #4's "late result still lands ⇒ spend recorded" promise. delivered_at
    // excludes every normally-served or race-settled row, so no double count.
    const orphaned = await tx
      .select({
        id: dispatchJobs.id,
        resultMeta: dispatchJobs.resultMeta,
        latencyMs: dispatchJobs.latencyMs,
        requestId: dispatchJobs.requestId,
      })
      .from(dispatchJobs)
      .where(and(
        eq(dispatchJobs.state, 'succeeded'),
        lt(dispatchJobs.finishedAt, new Date(Date.now() - CONTENT_TTL_MS)),
        sql`delivered_at IS NULL`,
        sql`scrubbed_at IS NULL`,
      ))
    for (const row of orphaned) {
      const meta = (row.resultMeta ?? {}) as { model?: string; usage?: Record<string, number>; workerId?: string }
      await recordAiRun({
        engine: 'agy',
        model: meta.model,
        source: 'chat',
        status: 'ok',
        latencyMs: row.latencyMs ?? 0,
        usage: meta.usage,
        requestId: row.requestId,
        meta: { dispatch: true, discarded: true, undelivered: true, jobId: row.id, workerId: meta.workerId },
      })
    }
    await tx
      .update(dispatchJobs)
      .set({ payloadText: null, resultText: null, scrubbedAt: now, updatedAt: now })
      .where(and(
        lt(dispatchJobs.finishedAt, new Date(Date.now() - CONTENT_TTL_MS)),
        sql`scrubbed_at IS NULL`,
      ))
    await tx
      .delete(dispatchJobs)
      .where(lt(dispatchJobs.createdAt, new Date(Date.now() - ROW_TTL_DAYS * 86_400_000)))
  })
}

export async function queueDepths(): Promise<Record<string, number>> {
  const rows = await db
    .select({ state: dispatchJobs.state, n: sql<number>`count(*)::int` })
    .from(dispatchJobs)
    .groupBy(dispatchJobs.state)
  return Object.fromEntries(rows.map((r) => [r.state, r.n]))
}

export interface RecentJob {
  id: string
  kind: string
  state: string
  attempt: number
  errorClass: string | null
  latencyMs: number | null
  promptChars: number | null
  createdAt: Date
  finishedAt: Date | null
  leasedBy: string | null
}

/** Provenance only — content columns are never selected here, scrubbed or not. */
export async function listRecentJobs(limit = 20): Promise<RecentJob[]> {
  return db
    .select({
      id: dispatchJobs.id,
      kind: dispatchJobs.kind,
      state: dispatchJobs.state,
      attempt: dispatchJobs.attempt,
      errorClass: dispatchJobs.errorClass,
      latencyMs: dispatchJobs.latencyMs,
      promptChars: dispatchJobs.promptChars,
      createdAt: dispatchJobs.createdAt,
      finishedAt: dispatchJobs.finishedAt,
      leasedBy: dispatchJobs.leasedBy,
    })
    .from(dispatchJobs)
    .orderBy(desc(dispatchJobs.createdAt))
    .limit(limit)
}

export interface WorkerRow {
  id: string
  lastSeenAt: Date
  version: string | null
  agyVersion: string | null
}

export async function listWorkers(): Promise<WorkerRow[]> {
  return db
    .select({
      id: dispatchWorkers.id,
      lastSeenAt: dispatchWorkers.lastSeenAt,
      version: dispatchWorkers.version,
      agyVersion: dispatchWorkers.agyVersion,
    })
    .from(dispatchWorkers)
    .orderBy(desc(dispatchWorkers.lastSeenAt))
}
