import { agyErrorType, agyGenerateText, agyVersion, truncateAgyError, type AgyOptions, type AgyResult } from '@/lib/agy'
import { createLogger } from '@/lib/logger'

/**
 * lib/dispatch-worker.ts — the desktop worker's core loop (Phase 2.5 PR 2).
 *
 * Runs INSIDE the desktop container (scripts/agy-worker/), never on Cloud Run:
 * it long-polls the Hub's /api/worker/claim outbound (the desktop is NAT'd),
 * executes claimed jobs through the same lib/agy.ts gateway the whole
 * migration is built on, heartbeats leases, and posts results into the
 * idempotent CAS. The entry point is hub/scripts/dispatch-worker.ts; this
 * module holds the logic so vitest can drive it with injected fetch/run fns.
 *
 * Slot policy — set by the 2026-08-19 concurrency test on the operator's
 * desktop (PARALLEL_OK: three simultaneous runs on one token, zero auth/rate
 * failures): slots MAY run truly in parallel. Defaults stay conservative
 * (1 chat slot, 0 work slots — nothing enqueues work_items until the panel
 * phase); raise WORKER_WORK_SLOTS when that lane goes live.
 *
 * Survival rules inherited, not reimplemented: pty, empty-is-failure, typed
 * errors all come from agyGenerateText. The worker adds only queue behavior:
 *  - a cancel arriving on the heartbeat aborts the agy child (AbortSignal →
 *    SIGTERM), bounding wasted allotment at one heartbeat interval;
 *  - a lost lease (heartbeat guard fails) aborts the same way;
 *  - result posts retry into the CAS — duplicates are acked, never re-run;
 *  - Hub unreachability backs off exponentially (1s → 60s, jittered) and
 *    never crashes the loop. The container's restart policy covers crashes.
 */

const log = createLogger('dispatch-worker')

export interface WorkerConfig {
  hubUrl: string
  secret: string
  workerId: string
  chatSlots: number
  workSlots: number
  version?: string
}

export interface WorkerDeps {
  fetchFn?: typeof fetch
  runFn?: (prompt: string, opts: AgyOptions) => Promise<AgyResult>
  agyVersionFn?: () => Promise<string | null>
  sleepFn?: (ms: number) => Promise<void>
}

export interface ClaimedJobWire {
  id: string
  kind: string
  attempt: number
  payloadText: string | null
  payloadMeta: { model?: string; effort?: 'low' | 'medium' | 'high' } | null
  deadlineAt: string
  heartbeatMs: number
}

export function workerConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig | { error: string } {
  const hubUrl = (env.HUB_URL ?? '').replace(/\/+$/, '')
  const secret = env.AGY_WORKER_SECRET ?? ''
  if (!hubUrl) return { error: 'HUB_URL is required (e.g. https://hub.casatrejo.com)' }
  if (!secret) return { error: 'AGY_WORKER_SECRET is required (must match the Hub side)' }
  const int = (v: string | undefined, dflt: number) => {
    const n = Number(v)
    return Number.isInteger(n) && n >= 0 ? n : dflt
  }
  return {
    hubUrl,
    secret,
    workerId: (env.WORKER_ID ?? 'danny-desktop').slice(0, 100),
    chatSlots: int(env.WORKER_CHAT_SLOTS, 1),
    workSlots: int(env.WORKER_WORK_SLOTS, 0),
    version: env.WORKER_GIT_SHA?.slice(0, 64),
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jitteredBackoff(attempt: number): number {
  const base = Math.min(1_000 * 2 ** attempt, 60_000)
  return Math.round(base * (0.5 + Math.random() * 0.5))
}

interface SlotContext {
  cfg: WorkerConfig
  kinds: string[]
  slotName: string
  fetchFn: typeof fetch
  runFn: (prompt: string, opts: AgyOptions) => Promise<AgyResult>
  sleepFn: (ms: number) => Promise<void>
  agyVersionValue: string | null
  stop: AbortSignal
}

async function postJson(
  ctx: SlotContext,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  // A residential NAT link can silently drop an idle mapping mid-long-poll,
  // leaving the socket half-open: without a signal the fetch would stall for
  // undici's ~300s default instead of the intended window. Bound every call.
  const res = await ctx.fetchFn(`${ctx.cfg.hubUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': ctx.cfg.secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json: Record<string, unknown> | null = null
  try {
    json = res.status === 204 ? null : ((await res.json()) as Record<string, unknown>)
  } catch {
    json = null
  }
  return { status: res.status, json }
}

/**
 * Execute one claimed job end to end: heartbeat timer, agy run, result post.
 * Never throws — every outcome becomes a result post (or a logged, abandoned
 * lease when even the post retries fail; the Hub's reaper finalizes those).
 */
export async function executeJob(ctx: SlotContext, job: ClaimedJobWire): Promise<void> {
  const started = Date.now()
  const controller = new AbortController()
  let cancelSeen = false

  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const { status, json } = await postJson(
          ctx,
          `/api/worker/jobs/${job.id}/heartbeat`,
          { workerId: ctx.cfg.workerId, attempt: job.attempt },
          5_000,
        )
        // Only an HTTP-200 verdict is definitive: { ok:false } is genuine
        // lease loss and { cancelRequested:true } a genuine Hub cancel. Any
        // non-200 (route 500 on a DB blip, platform 429/502/503) is
        // transient — skip the beat and lean on the 2.5x lease slack, else a
        // single hiccup aborts a near-complete run and burns the allotment.
        if (status === 200 && json?.ok !== true) {
          log.warn({ jobId: job.id, reason: json?.reason }, 'lease lost — aborting run')
          cancelSeen = true
          controller.abort()
        } else if (status === 200 && json?.cancelRequested === true) {
          log.info({ jobId: job.id }, 'Hub cancelled — aborting run (allotment stops here)')
          cancelSeen = true
          controller.abort()
        } else if (status !== 200) {
          log.warn({ jobId: job.id, status }, 'heartbeat got a transient error — skipping this beat')
        }
      } catch {
        // Network blip: skip this beat. The lease has 2.5x heartbeat slack.
      }
    })()
  }, Math.max(job.heartbeatMs, 1_000))

  let post: Record<string, unknown>
  try {
    const budget = new Date(job.deadlineAt).getTime() - Date.now() - 3_000
    const result = await ctx.runFn(job.payloadText ?? '', {
      timeoutMs: Math.max(budget, 5_000),
      signal: controller.signal,
      model: job.payloadMeta?.model,
      effort: job.payloadMeta?.effort,
    })
    post = {
      workerId: ctx.cfg.workerId,
      attempt: job.attempt,
      status: 'ok',
      text: result.text,
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
    }
  } catch (err) {
    post = {
      workerId: ctx.cfg.workerId,
      attempt: job.attempt,
      status: 'error',
      errorClass: cancelSeen ? 'abort' : agyErrorType(err),
      error: truncateAgyError(err),
      latencyMs: Date.now() - started,
    }
  } finally {
    clearInterval(heartbeat)
  }

  // The result CAS is idempotent — retries can only produce 'duplicate'.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { status, json } = await postJson(ctx, `/api/worker/jobs/${job.id}/result`, post, 15_000)
      if (status === 200 || status === 404) {
        log.info({ jobId: job.id, kind: job.kind, outcome: json?.outcome ?? status, status: post.status }, 'result posted')
        return
      }
    } catch {
      // fall through to backoff
    }
    await ctx.sleepFn(jitteredBackoff(attempt))
  }
  log.error({ jobId: job.id }, 'result post failed after retries — lease will lapse and the Hub reaper finalizes')
}

/** One slot's forever-loop: claim → execute → repeat, with backoff on trouble. */
export async function runSlot(ctx: SlotContext): Promise<void> {
  let failures = 0
  let lastHubSha: string | null = null
  while (!ctx.stop.aborted) {
    try {
      const { status, json } = await postJson(
        ctx,
        '/api/worker/claim',
        {
          workerId: ctx.cfg.workerId,
          kinds: ctx.kinds,
          waitMs: 25_000,
          version: ctx.cfg.version,
          agyVersion: ctx.agyVersionValue,
        },
        32_000, // just above the 25s long-poll so a healthy wait completes
      )
      if (status === 200 && json?.job) {
        failures = 0
        const hubSha = typeof json.hubSha === 'string' ? json.hubSha : null
        if (hubSha && ctx.cfg.version && hubSha !== ctx.cfg.version && hubSha !== lastHubSha) {
          lastHubSha = hubSha
          log.warn({ hubSha, workerSha: ctx.cfg.version }, 'version drift vs Hub — nightly update task will converge')
        }
        await executeJob(ctx, json.job as unknown as ClaimedJobWire)
      } else if (status === 204) {
        failures = 0 // empty long-poll is the healthy idle state; reconnect at once
      } else {
        failures += 1
        log.warn({ slot: ctx.slotName, status, error: json?.error }, 'claim rejected — backing off')
        await ctx.sleepFn(jitteredBackoff(failures))
      }
    } catch (err) {
      failures += 1
      log.warn({ slot: ctx.slotName, err: err instanceof Error ? err.message : String(err) }, 'Hub unreachable — backing off')
      await ctx.sleepFn(jitteredBackoff(failures))
    }
  }
}

/** Boot every configured slot; resolves only when `stop` aborts. */
export async function startWorker(cfg: WorkerConfig, deps: WorkerDeps = {}, stop?: AbortSignal): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch
  const runFn = deps.runFn ?? agyGenerateText
  const sleepFn = deps.sleepFn ?? defaultSleep
  const agyVersionValue = await (deps.agyVersionFn ?? agyVersion)()
  const signal = stop ?? new AbortController().signal

  log.info(
    { hubUrl: cfg.hubUrl, workerId: cfg.workerId, chatSlots: cfg.chatSlots, workSlots: cfg.workSlots, agyVersion: agyVersionValue },
    'dispatch worker starting (PARALLEL_OK slot policy)',
  )

  const slots: Promise<void>[] = []
  for (let i = 0; i < cfg.chatSlots; i++) {
    slots.push(runSlot({ cfg, kinds: ['chat_turn'], slotName: `chat-${i}`, fetchFn, runFn, sleepFn, agyVersionValue, stop: signal }))
  }
  for (let i = 0; i < cfg.workSlots; i++) {
    slots.push(runSlot({ cfg, kinds: ['work_item'], slotName: `work-${i}`, fetchFn, runFn, sleepFn, agyVersionValue, stop: signal }))
  }
  await Promise.all(slots)
}
