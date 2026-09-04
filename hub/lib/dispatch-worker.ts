import { agyErrorType, agyGenerateText, agyVersion, truncateAgyError, type AgyOptions, type AgyResult } from '@/lib/agy'
import { createLogger } from '@/lib/logger'
import { drainSpool, commitSpool, restoreSpool, MAX_DRAIN_RECORDS } from '@/lib/fault-spool'

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
  /** Run the boot canary before claiming (workerConfigFromEnv defaults ON;
   *  WORKER_CANARY=off is the escape hatch). Absent = off, so test harnesses
   *  that build configs by hand opt in explicitly. */
  canary?: boolean
  /** Delay between canary retries while the gate is failing. */
  canaryRetryMs?: number
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
    canary: env.WORKER_CANARY !== 'off',
    canaryRetryMs: int(env.WORKER_CANARY_RETRY_MS, 15 * 60 * 1000),
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

/** The boot-canary marker — a drifted envelope cannot round-trip it. */
export const BOOT_CANARY_MARKER = 'AGY_WORKER_BOOT_OK'

/**
 * Boot canary (hardening move 2): one marker prompt through the real agy
 * runner BEFORE any job is claimed. This catches envelope drift — an agy
 * update whose output interpretEnvelope can no longer read — at worker boot
 * instead of on a user's chat turn. While the gate fails the worker claims
 * NOTHING and retries on a slow clock; with no claims there is no fresh
 * heartbeat, so dispatch-health goes workerAlive:false and the move-1
 * alerting surfaces the flag within the hour.
 */
export async function runBootCanary(
  runFn: (prompt: string, opts: AgyOptions) => Promise<AgyResult>,
  sleepFn: (ms: number) => Promise<void>,
  retryMs: number,
  stop: AbortSignal,
): Promise<void> {
  const prompt = `Reply with exactly this token and nothing else: ${BOOT_CANARY_MARKER}`
  while (!stop.aborted) {
    try {
      const result = await runFn(prompt, { timeoutMs: 90_000, signal: stop })
      if (result.text.includes(BOOT_CANARY_MARKER)) {
        log.info({ model: result.model, latencyMs: result.latencyMs }, 'boot canary passed — starting slots')
        return
      }
      log.error(
        { got: result.text.slice(0, 80) },
        'boot canary: agy answered but the text lacks the marker — envelope drift suspected; refusing to claim jobs',
      )
    } catch (err) {
      log.error(
        { class: agyErrorType(err), error: truncateAgyError(err) },
        'boot canary failed — refusing to claim jobs',
      )
    }
    await sleepFn(retryMs)
  }
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

/**
 * The only statuses that mean "this batch is invalid and always will be":
 * a malformed body, an oversized body, or a schema rejection. Everything else
 * — including 401/403 (secret rotation), 404 (route not deployed yet), 408,
 * 429 and every 5xx — is transient from the worker's point of view and must
 * leave the spool intact for the next boot.
 */
const PERMANENTLY_REJECTED = new Set([400, 413, 422])

/**
 * Upload any crash records this worker spooled before it died
 * (ERROR_REPORTING §3 Layer 10). Boot is the FIRST moment an HTTP call is
 * safe — during the crash the process is going away and an async request
 * loses the race — so the spool is drained here, before slots start claiming.
 *
 * Best-effort by construction: this must never delay or prevent real work.
 * On any failure the batch is restored so the next boot retries it, and the
 * spool is bounded on the write side so a crash loop cannot grow it forever.
 */
/** Count of non-blank physical lines in a leftover string (see
 *  fault-spool.ts DrainedSpool.leftover): how many records the batch cap
 *  held back at a single claim. */
function countLines(leftover: string): number {
  return leftover.split('\n').filter((l) => l.trim() !== '').length
}

export async function uploadSpooledFaults(
  cfg: WorkerConfig,
  fetchFn: typeof fetch,
  timeoutMs = 10_000,
): Promise<{ uploaded: number; failed: boolean }> {
  // The FIRST claim is also the only one allowed to set the budget: batches
  // = 1 + ceil(leftoverLines / MAX_DRAIN_RECORDS), fixed from that one
  // snapshot. A worker that stays healthy never boots again, so a single
  // call — uploading only MAX_DRAIN_RECORDS and writing the rest back — would
  // leave records invisible until the nightly container rebuild discarded
  // them; looping until the LIVE spool is empty, or recomputing the budget
  // after every batch, both let a continuously-appending producer stall
  // startup forever. Fixing the budget at the initial snapshot drains every
  // record that was actually spooled at boot while staying finite regardless
  // of what gets appended concurrently — commitSpool always writes the
  // original leftover ahead of anything appended since the claim, so later
  // boots (or this one, up to budget) still deliver it in order.
  let uploaded = 0
  const first = await uploadOneSpooledBatch(cfg, fetchFn, timeoutMs)
  uploaded += first.uploaded
  if (!first.claimed || first.failed || !first.more) {
    return { uploaded, failed: first.failed }
  }

  const remainingBatches = Math.ceil(first.leftoverLines / MAX_DRAIN_RECORDS)
  for (let i = 0; i < remainingBatches; i++) {
    const batch = await uploadOneSpooledBatch(cfg, fetchFn, timeoutMs)
    uploaded += batch.uploaded
    if (batch.failed) return { uploaded, failed: true }
    if (!batch.more) break
  }
  return { uploaded, failed: false }
}

async function uploadOneSpooledBatch(
  cfg: WorkerConfig,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ uploaded: number; failed: boolean; more: boolean; claimed: boolean; leftoverLines: number }> {
  const { records, claimed, leftover } = drainSpool()
  const leftoverLines = countLines(leftover)
  if (!claimed || records.length === 0) {
    if (claimed) commitSpool(process.env, leftover) // empty/unparsable: discard
    return { uploaded: 0, failed: false, more: false, claimed, leftoverLines }
  }
  try {
    const res = await fetchFn(`${cfg.hubUrl}/api/worker/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-secret': cfg.secret },
      body: JSON.stringify({ workerId: cfg.workerId, faults: records }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status >= 200 && res.status < 300) {
      commitSpool(process.env, leftover)
      log.info({ uploaded: records.length }, 'uploaded spooled worker crash records')
      // `leftover` is non-empty exactly when the batch cap held records back.
      return { uploaded: records.length, failed: false, more: leftover !== '', claimed, leftoverLines }
    }
    // Drop ONLY on statuses that conclusively mean this payload will never be
    // accepted. The earlier blanket 4xx rule was too broad and destroyed good
    // records in two ordinary situations: a 401 while an AGY_WORKER_SECRET
    // rotation is briefly out of sync, and a 404 from a worker that updated
    // before the Hub deployment carrying this route finished. Both recover on
    // their own, so both must RESTORE and retry.
    if (PERMANENTLY_REJECTED.has(res.status)) {
      commitSpool(process.env, leftover)
      log.warn({ status: res.status, dropped: records.length }, 'hub rejected spooled crash records as invalid; dropping batch')
      return { uploaded: 0, failed: true, more: false, claimed, leftoverLines }
    }
    restoreSpool()
    log.warn({ status: res.status }, 'spooled crash record upload failed; will retry next boot')
    return { uploaded: 0, failed: true, more: false, claimed, leftoverLines }
  } catch (err) {
    restoreSpool()
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'spooled crash record upload errored; will retry next boot',
    )
    return { uploaded: 0, failed: true, more: false, claimed, leftoverLines }
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

  // Ship whatever the previous life spooled before doing anything else, so a
  // crash-restart loop still reports every iteration rather than only the
  // one that happens to survive.
  await uploadSpooledFaults(cfg, fetchFn)

  // Envelope-drift gate: no claims until one marker prompt round-trips.
  if (cfg.canary === true) {
    await runBootCanary(runFn, sleepFn, cfg.canaryRetryMs ?? 15 * 60 * 1000, signal)
    if (signal.aborted) return
  }

  const slots: Promise<void>[] = []
  for (let i = 0; i < cfg.chatSlots; i++) {
    slots.push(runSlot({ cfg, kinds: ['chat_turn'], slotName: `chat-${i}`, fetchFn, runFn, sleepFn, agyVersionValue, stop: signal }))
  }
  for (let i = 0; i < cfg.workSlots; i++) {
    slots.push(runSlot({ cfg, kinds: ['work_item'], slotName: `work-${i}`, fetchFn, runFn, sleepFn, agyVersionValue, stop: signal }))
  }
  await Promise.all(slots)
}
