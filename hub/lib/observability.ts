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
 */
import crypto from 'crypto'

/** Which model family served (or attempted) the request. */
export type AiProvider = 'claude' | 'gemini'

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
  | { type: 'ai_fallback'; requestId: string; from: string; to: string; reason: string }
  | { type: 'ai_error'; requestId: string; provider?: AiProvider; code: string; message: string }

/**
 * Cheap guard so the seam can be turned off entirely (default ON, including in
 * tests via captured console). Only an explicit `OBSERVABILITY_ENABLED=false`
 * silences it — any other value (or unset) keeps telemetry on in prod.
 */
export function observabilityEnabled(): boolean {
  return process.env.OBSERVABILITY_ENABLED !== 'false'
}

/**
 * Emit one structured telemetry line. `ts` is a normal wall-clock ISO timestamp
 * (fine in app code — the no-Date rule only applies to workflow scripts). One
 * line per lifecycle event, NEVER per chunk.
 */
export function emit(event: TelemetryEvent): void {
  if (!observabilityEnabled()) return
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }))
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
