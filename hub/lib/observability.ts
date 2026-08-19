/**
 * AI-path observability — a tiny, dependency-free structured telemetry emitter.
 *
 * Cloud Run captures stdout → Cloud Logging, so a single JSON line per lifecycle
 * event is the cheapest viable structured sink. This module owns:
 *   - the discriminated event schema (TelemetryEvent, keyed on `type`),
 *   - `emit()` — one `console.log(JSON.stringify(...))` per event,
 *   - `newRequestId()` / `startTimer()` correlation + latency helpers,
 *   - `hashEmail()` — the ONLY sanctioned way to attach a per-user dimension.
 *
 * PII discipline (HARD requirement): NEVER pass message content, a raw user
 * email, or a Google/OAuth token into an event. If a per-user dimension is
 * needed, use `hashEmail(email)` (a non-reversible sha256 prefix) — never the
 * raw address. This is enforced by observability.test.ts.
 *
 * This is a PURE LOGGING SEAM: emitting an event must never alter streaming,
 * timeout, or fallback behavior. Every emit path is guarded and side-effect-free
 * beyond the log line itself.
 *
 * NS-10 adds a best-effort DB sink: the operationally-interesting subset of
 * events (see PERSISTED_EVENT_TYPES) is ALSO copied into the append-only
 * `event_log` table (eventType `telemetry:<type>`) so /admin/ai-health can
 * aggregate them. The sink is fire-and-forget — it never makes emit() async,
 * never throws, and is guarded by TELEMETRY_DB_SINK (default ON outside unit
 * tests). The stdout line remains the source of truth.
 */
import crypto from 'crypto'

/** Which model family served (or attempted) the request. 'agy' is the
 *  Antigravity CLI execution gateway (lib/agy-chat.ts) — subscription
 *  allotment, not metered API. */
export type AiProvider = 'claude' | 'gemini' | 'agy'

/** Timeout layer that tripped — matches the ladder in lib/timeout-config.ts. */
export type TimeoutLayer = 'connect' | 'idle'

/**
 * The structured event stream for one AI request, discriminated on `type`.
 * Every event carries a `requestId` so a request's whole lifecycle correlates
 * in Cloud Logging. NOTE: no event ever carries message content, an email, or a
 * token — see the module-level PII note.
 */
export type TelemetryEvent =
  | { type: 'ai_request_start'; requestId: string; route: string }
  | { type: 'ai_provider_selected'; requestId: string; provider: AiProvider; model: string; attempt: number }
  | { type: 'ai_first_token'; requestId: string; ms: number }
  | { type: 'ai_complete'; requestId: string; ms: number; provider: AiProvider | 'unknown'; model: string; finishReason?: string }
  | { type: 'ai_timeout'; requestId: string; layer: TimeoutLayer; provider: AiProvider; model: string }
  /** The model stopped because max_tokens was exhausted (stop_reason
   *  "max_tokens") — the documented signature of a truncated or
   *  thinking-consumed response. Watch this metric to tune max_tokens/effort. */
  | { type: 'ai_truncated'; provider: AiProvider; model: string; requestId?: string }
  | { type: 'ai_fallback'; requestId: string; from: string; to: string; reason: string }
  | { type: 'ai_error'; requestId: string; provider?: AiProvider; code: string; message: string }
  /* Desktop dispatch (Phase 2.5) lifecycle — DESKTOP_DISPATCH_2026-08-15.md §6.
   * jobId is the correlation spine; requestId ties chat-originated jobs back
   * to the turn. Stdout-only (not in PERSISTED_EVENT_TYPES): the durable
   * record is ai_runs; these exist for claim-latency/cancel/expiry rates. */
  | { type: 'dispatch_enqueued'; jobId: string; kind: string; requestId?: string }
  | { type: 'dispatch_claimed'; jobId: string; kind: string; workerId: string; attempt: number; queueMs: number; requestId?: string }
  | { type: 'dispatch_result'; jobId: string; workerId: string; outcome: string; status: string; requestId?: string }
  | { type: 'dispatch_cancelled'; jobId: string; reason: string; requestId?: string }
  | { type: 'dispatch_expired'; jobId?: string; count: number; reason: 'lease_expired' | 'deadline'; requestId?: string }

/**
 * Cheap guard so the seam can be turned off entirely (default ON, including in
 * tests via captured console). Only an explicit `OBSERVABILITY_ENABLED=false`
 * silences it — any other value (or unset) keeps telemetry on in prod.
 */
export function observabilityEnabled(): boolean {
  return process.env.OBSERVABILITY_ENABLED !== 'false'
}

/**
 * The subset of events worth persisting to Postgres for the AI Health panel:
 * request-terminal outcomes plus the two mid-flight incidents. start /
 * provider_selected / first_token stay stdout-only to keep write volume low —
 * one request yields at most ~2 persisted rows (a terminal event plus possibly
 * a fallback/timeout on the way there).
 */
const PERSISTED_EVENT_TYPES: ReadonlySet<TelemetryEvent['type']> = new Set([
  'ai_complete',
  'ai_timeout',
  'ai_fallback',
  'ai_error',
])

/**
 * Whether the best-effort DB sink is active. Default ON; an explicit
 * `TELEMETRY_DB_SINK=off` disables it. Under NODE_ENV=test the sink is OFF
 * unless explicitly opted in with `TELEMETRY_DB_SINK=on`, so unit tests that
 * exercise emit() never attempt a database write.
 */
export function telemetryDbSinkEnabled(): boolean {
  const flag = process.env.TELEMETRY_DB_SINK
  if (flag === 'off') return false
  if (process.env.NODE_ENV === 'test') return flag === 'on'
  return true
}

/**
 * Lazily-loaded event-logger module, resolved AT MOST ONCE. The lazy dynamic
 * import avoids a static observability → event-logger → db edge (import-cycle
 * and client-bundle safety); the cached promise means concurrent emits share
 * one resolution instead of racing N import() calls. A failed load clears the
 * cache so a later emit can retry.
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

/**
 * Fire-and-forget copy of one event into `event_log`. Best-effort by
 * construction: the event-logger module is loaded lazily (no import cycle, no
 * client-bundle contamination, no crash if the DB layer can't initialize) and
 * every failure — import, insert, anything — is swallowed. The persisted row
 * drops `requestId` from the payload (it becomes `correlation_id`) and never
 * contains message content / emails / tokens because TelemetryEvent itself
 * never carries them (see the module-level PII note).
 */
function persistTelemetryEvent(event: TelemetryEvent): void {
  try {
    const { requestId, ...payload } = event
    void loadEventLogger()
      .then(({ recordEvent }) =>
        recordEvent({
          eventType: `telemetry:${event.type}`,
          actor: 'system',
          correlationId: requestId,
          payload,
        }),
      )
      .catch(() => {
        /* best-effort — a DB outage must never surface here */
      })
  } catch {
    /* best-effort — even a synchronous failure is swallowed */
  }
}

/**
 * Emit one structured telemetry line. `ts` is a normal wall-clock ISO timestamp
 * (fine in app code — the no-Date rule only applies to workflow scripts). One
 * line per lifecycle event, NEVER per chunk. Stays SYNCHRONOUS for callers —
 * the optional DB sink below is fire-and-forget.
 */
export function emit(event: TelemetryEvent): void {
  if (!observabilityEnabled()) return
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }))
  if (PERSISTED_EVENT_TYPES.has(event.type) && telemetryDbSinkEnabled()) {
    persistTelemetryEvent(event)
  }
}

/** Correlation id for a single AI request. Wraps crypto.randomUUID(). */
export function newRequestId(): string {
  return crypto.randomUUID()
}

/**
 * Start an elapsed-ms timer. Returns a closure yielding whole milliseconds since
 * the call. Uses performance.now() for a monotonic clock (not affected by wall
 * clock jumps), so successive reads never go backwards.
 */
export function startTimer(): () => number {
  const start = performance.now()
  return () => Math.round(performance.now() - start)
}

/**
 * Non-reversible per-user dimension. sha256 the normalized email and keep a
 * 12-char prefix — enough to group/count a user across events without ever
 * logging the raw address. This is the ONLY approved way to attach a user
 * dimension to telemetry. The output contains no '@' and cannot be reversed.
 */
export function hashEmail(email: string): string {
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12)
}
