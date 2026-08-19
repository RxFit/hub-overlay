import type { AgyResult } from '@/lib/agy'
import {
  cancelJob,
  deliverResult,
  enqueueJob,
  getJobView,
  workerFresh,
} from '@/lib/dispatch-store'
import { createLogger } from '@/lib/logger'

/**
 * lib/agy-dispatch.ts — Hub-side desktop dispatch (Phase 2.5).
 *
 * Substitutes for agyGenerateText when AGY_DISPATCH_ENABLED is set: instead of
 * spawning agy locally (impossible on Cloud Run — Google refuses consumer-
 * OAuth refresh from datacenter IPs), the prompt is enqueued in Postgres and a
 * desktop worker on a residential IP executes it. Same AgyResult shape, same
 * typed-`agyError` throw contract, so tryAgyChat's ledger/cooldown/fallback
 * machinery is inherited unchanged. New error classes (all open TEXT in
 * ai_runs, zero migration): no_worker | queue_full | claim_timeout |
 * lease_expired | abort — plus the worker relaying agy's own taxonomy.
 *
 * The never-stall ladder, in order of how fast each rung fails:
 *   ~5ms  liveness gate (one indexed read of dispatch_workers)
 *   ≤5s   claim window (job still queued ⇒ worker wedged ⇒ cancel + throw)
 *   ≤budget  run window (fails fast the moment the lease lapses)
 * Any rung throws ⇒ tryAgyChat's existing catch ⇒ metered chain. A dead
 * worker costs a turn one SELECT, not seconds.
 */

const log = createLogger('agy-dispatch')

/** Dispatch transport selected? (The chat flag itself stays AGY_CHAT_ENABLED.) */
export function isDispatchEnabled(): boolean {
  const flag = process.env.AGY_DISPATCH_ENABLED
  return flag === 'true' || flag === '1'
}

/** Worker-facing credential present? The dispatch analogue of isAgyConfigured. */
export function isDispatchConfigured(): boolean {
  return Boolean(process.env.AGY_WORKER_SECRET)
}

export function dispatchFreshMs(): number {
  const raw = Number(process.env.AGY_DISPATCH_FRESH_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000
}

export function dispatchClaimTimeoutMs(): number {
  const raw = Number(process.env.AGY_DISPATCH_CLAIM_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000
}

function dispatchError(type: string, message: string): Error {
  // Same shape as lib/agy.ts agyError — agyErrorType() reads it identically.
  return Object.assign(new Error(message), { agyError: { type, message } })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface DispatchOptions {
  budgetMs: number
  requestId?: string
  signal?: AbortSignal
}

interface WorkerResultMeta {
  model?: string
  usage?: AgyResult['usage']
  workerId?: string
  latencyMs?: number
}

export async function dispatchGenerateText(prompt: string, opts: DispatchOptions): Promise<AgyResult> {
  const started = Date.now()

  if (!isDispatchConfigured()) {
    throw dispatchError('not_configured', 'AGY_DISPATCH_ENABLED is set but AGY_WORKER_SECRET is not — dispatch has no worker credential')
  }

  // Rung 1 — the ~5ms liveness gate. Any store failure (including a missing
  // table: migrations are non-fatal by contract) reads as "no worker".
  let fresh = false
  try {
    fresh = await workerFresh(dispatchFreshMs())
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'liveness read failed — treating as no worker')
  }
  if (!fresh) {
    throw dispatchError('no_worker', `no dispatch worker seen in the last ${dispatchFreshMs()}ms`)
  }

  // Rung 2 — enqueue (with backpressure: a queue the desktop can't drain in
  // time only guarantees deadline expiry, so refuse ⇒ metered fallthrough).
  let jobId: string
  try {
    const outcome = await enqueueJob({
      kind: 'chat_turn',
      prompt,
      deadlineMs: opts.budgetMs,
      requestId: opts.requestId,
    })
    if ('refused' in outcome) {
      throw dispatchError('queue_full', 'dispatch queue at chat capacity — desktop cannot drain more in this budget')
    }
    jobId = outcome.id
  } catch (err) {
    if ((err as { agyError?: unknown }).agyError) throw err
    throw dispatchError('no_worker', `dispatch enqueue failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Rung 3 — wait. Fast polls early (pickup is normally ≤1.7s), then 500ms.
  // Every exit path that abandons the job cancels it, so the worker stands
  // down at its next heartbeat instead of running for a reader that left.
  const claimDeadline = started + dispatchClaimTimeoutMs()
  try {
    for (;;) {
      if (opts.signal?.aborted) {
        void cancelJob(jobId).catch(() => {})
        throw dispatchError('abort', 'client aborted while dispatch was in flight')
      }
      const elapsed = Date.now() - started
      if (elapsed >= opts.budgetMs) {
        void cancelJob(jobId).catch(() => {})
        throw dispatchError('timeout', `dispatch budget (${opts.budgetMs}ms) exhausted`)
      }

      const view = await getJobView(jobId)
      if (!view) {
        throw dispatchError('unknown', 'dispatch job row vanished mid-wait')
      }

      if (view.state === 'queued' && Date.now() > claimDeadline) {
        void cancelJob(jobId).catch(() => {})
        throw dispatchError('claim_timeout', `worker looked alive but did not claim within ${dispatchClaimTimeoutMs()}ms`)
      }
      if (view.state === 'leased' && view.leaseExpiresAt !== null && view.leaseExpiresAt.getTime() < Date.now()) {
        // Fail fast — never wait for the lazy reaper to notice.
        void cancelJob(jobId).catch(() => {})
        throw dispatchError('lease_expired', 'worker went silent mid-run (lease lapsed)')
      }
      if (view.state === 'succeeded') {
        const delivered = await deliverResult(jobId)
        if (!delivered) {
          throw dispatchError('unknown', 'job succeeded but its result was not deliverable (already read or scrubbed)')
        }
        const meta = (delivered.resultMeta ?? {}) as WorkerResultMeta
        return {
          text: delivered.text,
          model: meta.model,
          usage: meta.usage,
          raw: { dispatch: true, jobId, workerId: meta.workerId, workerLatencyMs: meta.latencyMs },
          latencyMs: Date.now() - started,
        }
      }
      if (view.state === 'failed') {
        throw dispatchError(view.errorClass ?? 'unknown', view.error ?? 'worker reported failure')
      }
      if (view.state === 'expired' || view.state === 'cancelled') {
        throw dispatchError(view.errorClass ?? 'lease_expired', view.error ?? `dispatch job ${view.state}`)
      }

      await sleep(elapsed < 2_000 ? 250 : 500)
    }
  } catch (err) {
    if ((err as { agyError?: unknown }).agyError) throw err
    // A store read blew up mid-wait (e.g. DB hiccup): give the turn to the
    // metered chain rather than burning the rest of the budget retrying.
    void cancelJob(jobId).catch(() => {})
    throw dispatchError('no_worker', `dispatch wait failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
