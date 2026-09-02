import { type FaultDraft, type FaultRecord, scrubFreeText } from '@/lib/fault'
import { telemetryDbSinkEnabled } from '@/lib/observability'
import { gcpTraceFields, type TraceContext } from '@/lib/trace-context'

/**
 * The fault reporter (ERROR_REPORTING_2026-08-24.md §8, §9 Tier 1–2).
 *
 * ONE stdout line per reported fault, in Google Cloud Error Reporting's
 * ReportedErrorEvent shape, so GCP groups server faults and notifies on
 * new/reopened groups at $0 — a second, independently-tuned grouping engine
 * beside our own fingerprint. The line is UNCONDITIONAL: it is deliberately
 * NOT gated by OBSERVABILITY_ENABLED (that flag governs AI-path telemetry; a
 * fault pipeline that inherits a kill switch silently disappears).
 *
 * A best-effort copy also lands in Postgres `event_log` (eventType
 * 'telemetry:fault', correlation_id = requestId) — the same wire convention
 * as lib/observability.ts's DB sink, via the same lazy-import pattern, so
 * the aggregation reads land in one table. The DB write uses
 * recordEventStrict (which REJECTS on failure) precisely so `sinkFailed`
 * below can count dropped writes: recordEvent's own catch swallows failure
 * and would leave the counter permanently zero. Absence of errors is not
 * evidence of health — the counters are how this pipeline observes itself.
 *
 * HARD GUARANTEES:
 *  - reportFault NEVER throws and never awaits on the caller's path.
 *  - The reporter never reports itself: a fault raised while reporting one
 *    increments `selfFaults` and returns (the reentrancy latch), so a DB
 *    outage cannot turn every request into a report storm.
 *
 * Volume control (in precedence order — the global ceiling wins):
 *  - global ceiling: ≤ CEILING_MAX writes per rolling hour per instance;
 *    overflow increments `ringFull` (a ceiling hit during a deploy is itself
 *    the incident — the zero-signal alarm reads these counters).
 *  - per-fingerprint token bucket: first BUCKET_MAX occurrences per
 *    BUCKET_WINDOW_MS emit a full record; beyond that only `suppressed`
 *    increments. Never drops an UNSEEN fingerprint before the ceiling.
 *
 * KNOWN RESIDUAL: all state here is per-process. Cloud Run runs 1–3
 * instances, so suppression is up to 3× looser than configured — accepted;
 * durable dedup lives where it matters (alert posting, Phase 4).
 */

export const BUCKET_MAX = 5
export const BUCKET_WINDOW_MS = 10 * 60_000
export const CEILING_MAX = 500
export const CEILING_WINDOW_MS = 60 * 60_000

/** GCP LogEntry severities. Error Reporting ingests ERROR and above. */
const GCP_SEVERITY: Record<FaultRecord['severity'], string> = {
  fatal: 'CRITICAL',
  error: 'ERROR',
  degraded: 'WARNING',
  expected: 'INFO',
}

interface FaultReportCounters {
  reported: number
  suppressed: number
  ringFull: number
  sinkFailed: number
  selfFaults: number
}

const counters: FaultReportCounters = {
  reported: 0,
  suppressed: 0,
  ringFull: 0,
  sinkFailed: 0,
  selfFaults: 0,
}

/** Per-fingerprint emit timestamps inside the current bucket window. */
const buckets = new Map<string, number[]>()
/** Timestamps of every write inside the current ceiling window. */
let ceilingWindow: number[] = []
/** The reentrancy latch — see the module header. */
let inReporter = false

/**
 * Lazily-loaded event-logger, resolved at most once (the exact pattern of
 * lib/observability.ts's sink: no static → db edge, concurrent reports share
 * one resolution, a failed load clears the cache so a later report retries).
 */
let eventLoggerModule: Promise<typeof import('./event-logger')> | null = null
function loadEventLogger(): Promise<typeof import('./event-logger')> {
  if (!eventLoggerModule) {
    eventLoggerModule = import('./event-logger')
    eventLoggerModule.catch(() => {
      eventLoggerModule = null
    })
  }
  return eventLoggerModule
}

export interface ReportFaultOptions {
  /** The RAW V8 stack, scrubbed here with line numbers KEPT — Error
   *  Reporting's grouper needs a V8-shaped stack. This is a different
   *  derivation from FaultRecord.stack (frames, line numbers stripped);
   *  same source, two purposes. */
  rawStack?: string | null
  /** Parsed traceparent, when the boundary has one — emitted as the
   *  `logging.googleapis.com/trace` field so the fault line nests under the
   *  Cloud Run request log (Layer 0). */
  trace?: TraceContext | null
  /** Injectable clock, matching lib/rate-limit.ts's convention. */
  now?: number
  /**
   * The ISO time the fault ACTUALLY occurred, when that differs from now —
   * a worker fault spooled across a crash and uploaded on the next boot may
   * be minutes or hours old, and stamping it with ingest time would silently
   * misdate the incident. Volume control still uses `now`, because bucketing
   * is about the rate we are emitting at, not when the fault happened.
   */
  occurredAt?: string
  /**
   * serviceContext.service override. GCP Error Reporting groups by service,
   * so a worker fault re-reported by the Hub must NOT be labelled 'hub' —
   * that would merge desktop-worker crashes into the server's groups and make
   * both harder to read. Defaults to 'hub'.
   */
  service?: string
}

/** Report one fault. Synchronous for the caller; never throws. */
export function reportFault(draft: FaultDraft, opts: ReportFaultOptions = {}): void {
  if (inReporter) {
    counters.selfFaults++
    return
  }
  inReporter = true
  try {
    const now = opts.now ?? Date.now()

    // Global ceiling first — it wins over everything, including unseen
    // fingerprints (§8 precedence).
    ceilingWindow = ceilingWindow.filter((t) => now - t < CEILING_WINDOW_MS)
    if (ceilingWindow.length >= CEILING_MAX) {
      counters.ringFull++
      return
    }

    // Per-fingerprint token bucket.
    const window = (buckets.get(draft.fingerprint) ?? []).filter((t) => now - t < BUCKET_WINDOW_MS)
    if (window.length >= BUCKET_MAX) {
      buckets.set(draft.fingerprint, window)
      counters.suppressed++
      return
    }
    window.push(now)
    buckets.set(draft.fingerprint, window)
    ceilingWindow.push(now)
    if (buckets.size > 2_000) sweepBuckets(now)

    const fault: FaultRecord = { ts: opts.occurredAt ?? new Date(now).toISOString(), ...draft }

    // Error Reporting wants exactly one of message/exception/stack_trace and
    // evaluates stack_trace → exception → message; we emit `message` only,
    // carrying the scrubbed V8 stack when we have one.
    const gcpMessage = opts.rawStack
      ? scrubFreeText(opts.rawStack)
      : `${fault.errName ?? fault.code}: ${fault.message}`

    const line = {
      severity: GCP_SEVERITY[fault.severity],
      message: gcpMessage,
      ...gcpTraceFields(opts.trace ?? null),
      serviceContext: { service: opts.service ?? 'hub', version: fault.release },
      context: fault.route
        ? {
            httpRequest: {
              method: fault.method ?? undefined,
              url: fault.route,
              responseStatusCode: fault.httpStatus ?? undefined,
            },
          }
        : undefined,
      fault,
    }
    // Unconditional — the one sink that survives a Postgres outage.
    console.log(JSON.stringify(line))
    counters.reported++

    // Best-effort DB copy, fire-and-forget. recordEventStrict rejects on
    // failure — the only reason sinkFailed can count at all.
    if (telemetryDbSinkEnabled()) {
      const { ts: _ts, ...payload } = fault
      void loadEventLogger()
        .then(({ recordEventStrict }) =>
          recordEventStrict({
            eventType: 'telemetry:fault',
            actor: 'system',
            correlationId: fault.requestId,
            ...(fault.tenantId ? { tenantId: fault.tenantId } : {}),
            payload: { ts: fault.ts, ...payload },
          }),
        )
        .catch(() => {
          counters.sinkFailed++
        })
    }
  } catch {
    // The reporter can never break a request — even its own bugs are
    // swallowed, and counted.
    counters.selfFaults++
  } finally {
    inReporter = false
  }
}

/** Snapshot of the drop-accounting counters (for /api/healthz and digests). */
export function getFaultReportCounters(): Readonly<FaultReportCounters> {
  return { ...counters }
}

function sweepBuckets(now: number): void {
  for (const [k, v] of buckets) {
    const live = v.filter((t) => now - t < BUCKET_WINDOW_MS)
    if (live.length === 0) buckets.delete(k)
    else buckets.set(k, live)
  }
}

/** Test hook: reset all module state (counters, buckets, ceiling, latch). */
export function _resetFaultReportStateForTests(): void {
  counters.reported = 0
  counters.suppressed = 0
  counters.ringFull = 0
  counters.sinkFailed = 0
  counters.selfFaults = 0
  buckets.clear()
  ceilingWindow = []
  inReporter = false
}
