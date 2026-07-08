/**
 * AI Health aggregation (NS-10) — PURE functions only.
 *
 * Turns the persisted telemetry rows (`event_log` rows with
 * eventType `telemetry:*`, written by lib/observability.ts's DB sink) plus the
 * `ai_action_log` rows for the same window into one AiHealth aggregate:
 * request counts, success/fallback rates, latency percentiles, error/timeout
 * breakdowns, action counts, and an `alerts[]` list evaluated against the
 * named threshold constants below.
 *
 * No I/O and no Date.now() — everything derives from the rows and the window
 * length passed in, so the whole module is unit-testable with fixtures
 * (lib/ai-health.test.ts) and shared verbatim by the API route.
 */

/* ── Alert thresholds (documented defaults — change here, not inline) ────── */

/** Fallback rate strictly ABOVE this fraction of requests → warn. */
export const FALLBACK_WARN = 0.25
/** Fallback rate strictly ABOVE this fraction of requests → critical. */
export const FALLBACK_CRIT = 0.5
/** Success rate strictly BELOW this fraction → critical. */
export const SUCCESS_CRIT = 0.9
/** Timeouts per hour AT OR ABOVE this rate → warn. */
export const TIMEOUTS_PER_HOUR_WARN = 5
/** Rate-limited actions per hour strictly ABOVE this rate → warn. */
export const RATE_LIMITED_PER_HOUR_WARN = 10

/* ── Input row shapes (what the route selects from the DB) ───────────────── */

/** One persisted telemetry row (event_log, eventType `telemetry:<type>`). */
export interface TelemetryRow {
  eventType: string
  payload: Record<string, unknown> | null
  createdAt: Date | string
}

/** One ai_action_log row (only the fields the aggregate needs). */
export interface ActionRow {
  actionType: string
  status: string
  error: string | null
  createdAt: Date | string
}

/* ── Output shape ─────────────────────────────────────────────────────────── */

export type AlertSeverity = 'warn' | 'critical'

export interface AiHealthAlert {
  id: 'fallback_rate' | 'success_rate' | 'timeouts' | 'rate_limited'
  severity: AlertSeverity
  message: string
  /** The measured value the threshold was compared against. */
  value: number
  /** The threshold that fired. */
  threshold: number
}

export interface RecentFailure {
  /** ISO timestamp of the failure. */
  at: string
  kind: 'ai_error' | 'action_failed'
  /** Error code (telemetry `code` / action `error` reason) — a known scalar. */
  code: string
  provider?: string
  actionType?: string
}

export interface AiHealth {
  /** Terminal AI requests in the window: ai_complete + ai_error. */
  requests: number
  /** completes / requests — null when the window saw no requests. */
  successRate: number | null
  fallbacks: number
  /** fallbacks / requests — null when the window saw no requests. */
  fallbackRate: number | null
  timeouts: number
  timeoutsByLayer: Record<string, number>
  errors: number
  errorsByCode: Record<string, number>
  /** End-to-end latency from ai_complete.ms (nearest-rank percentiles). */
  latencyMs: { p50: number | null; p95: number | null }
  /** First-token latency p50 — null unless telemetry:ai_first_token rows exist
   *  (first_token is stdout-only today, so this is normally null). */
  firstTokenMs: { p50: number | null }
  actions: {
    total: number
    byType: Record<string, number>
    byStatus: Record<string, number>
  }
  /** Actions that failed with error === 'rate_limited'. */
  rateLimited: number
  /** Last 10 failures (telemetry ai_error + failed actions), newest first. */
  recentFailures: RecentFailure[]
  alerts: AiHealthAlert[]
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/**
 * Nearest-rank percentile: sort ascending, take the value at
 * rank = ceil(p/100 * n). Deterministic, no interpolation. Returns null for an
 * empty set — never NaN.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].slice().sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[Math.min(rank, sorted.length) - 1]
}

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString()
}

function toMillis(d: Date | string): number {
  return d instanceof Date ? d.getTime() : new Date(d).getTime()
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

/** Payload field as a finite number, else null (payloads are untrusted jsonb). */
function num(payload: Record<string, unknown> | null, key: string): number | null {
  const v = payload?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Payload field as a non-empty string, else the fallback. */
function str(payload: Record<string, unknown> | null, key: string, fallback = 'unknown'): string {
  const v = payload?.[key]
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

/** `telemetry:ai_complete` → `ai_complete` (tolerates an unprefixed type). */
function telemetryType(eventType: string): string {
  return eventType.startsWith('telemetry:') ? eventType.slice('telemetry:'.length) : eventType
}

/* ── The aggregate ────────────────────────────────────────────────────────── */

/**
 * Compute the AI-health aggregate for one window. `windowMs` is the length of
 * the window the rows were fetched for — used ONLY to normalize the per-hour
 * alert thresholds (timeouts, rate-limited); the rows themselves are assumed
 * pre-filtered by the caller.
 */
export function computeAiHealth(
  telemetryRows: TelemetryRow[],
  actionRows: ActionRow[],
  windowMs: number,
): AiHealth {
  const hours = windowMs > 0 ? windowMs / 3_600_000 : 1

  let completes = 0
  let errors = 0
  let fallbacks = 0
  let timeouts = 0
  const timeoutsByLayer: Record<string, number> = {}
  const errorsByCode: Record<string, number> = {}
  const latencies: number[] = []
  const firstTokens: number[] = []
  const failures: RecentFailure[] = []

  for (const row of telemetryRows) {
    const type = telemetryType(row.eventType)
    if (type === 'ai_complete') {
      completes++
      const ms = num(row.payload, 'ms')
      if (ms !== null) latencies.push(ms)
    } else if (type === 'ai_error') {
      errors++
      const code = str(row.payload, 'code')
      bump(errorsByCode, code)
      const provider = row.payload?.provider
      failures.push({
        at: toIso(row.createdAt),
        kind: 'ai_error',
        code,
        ...(typeof provider === 'string' ? { provider } : {}),
      })
    } else if (type === 'ai_timeout') {
      timeouts++
      bump(timeoutsByLayer, str(row.payload, 'layer'))
    } else if (type === 'ai_fallback') {
      fallbacks++
    } else if (type === 'ai_first_token') {
      const ms = num(row.payload, 'ms')
      if (ms !== null) firstTokens.push(ms)
    }
    // Unknown telemetry types are ignored — forward compatible.
  }

  const actionsByType: Record<string, number> = {}
  const actionsByStatus: Record<string, number> = {}
  let rateLimited = 0
  for (const a of actionRows) {
    bump(actionsByType, a.actionType)
    bump(actionsByStatus, a.status)
    if (a.error === 'rate_limited') rateLimited++
    if (a.status === 'failed') {
      failures.push({
        at: toIso(a.createdAt),
        kind: 'action_failed',
        code: a.error ?? 'unknown',
        actionType: a.actionType,
      })
    }
  }

  const requests = completes + errors
  const successRate = requests > 0 ? completes / requests : null
  const fallbackRate = requests > 0 ? fallbacks / requests : null

  /* ── Alerts — exact boundary semantics documented on each constant ── */
  const alerts: AiHealthAlert[] = []
  if (fallbackRate !== null && fallbackRate > FALLBACK_WARN) {
    const critical = fallbackRate > FALLBACK_CRIT
    alerts.push({
      id: 'fallback_rate',
      severity: critical ? 'critical' : 'warn',
      message: `Fallback rate ${(fallbackRate * 100).toFixed(1)}% exceeds ${((critical ? FALLBACK_CRIT : FALLBACK_WARN) * 100).toFixed(0)}%`,
      value: fallbackRate,
      threshold: critical ? FALLBACK_CRIT : FALLBACK_WARN,
    })
  }
  if (successRate !== null && successRate < SUCCESS_CRIT) {
    alerts.push({
      id: 'success_rate',
      severity: 'critical',
      message: `Success rate ${(successRate * 100).toFixed(1)}% is below ${(SUCCESS_CRIT * 100).toFixed(0)}%`,
      value: successRate,
      threshold: SUCCESS_CRIT,
    })
  }
  const timeoutsPerHour = timeouts / hours
  if (timeoutsPerHour >= TIMEOUTS_PER_HOUR_WARN) {
    alerts.push({
      id: 'timeouts',
      severity: 'warn',
      message: `${timeoutsPerHour.toFixed(1)} timeouts/hour (threshold ${TIMEOUTS_PER_HOUR_WARN}/h)`,
      value: timeoutsPerHour,
      threshold: TIMEOUTS_PER_HOUR_WARN,
    })
  }
  const rateLimitedPerHour = rateLimited / hours
  if (rateLimitedPerHour > RATE_LIMITED_PER_HOUR_WARN) {
    alerts.push({
      id: 'rate_limited',
      severity: 'warn',
      message: `${rateLimitedPerHour.toFixed(1)} rate-limited actions/hour (threshold ${RATE_LIMITED_PER_HOUR_WARN}/h)`,
      value: rateLimitedPerHour,
      threshold: RATE_LIMITED_PER_HOUR_WARN,
    })
  }

  failures.sort((a, b) => toMillis(b.at) - toMillis(a.at))

  return {
    requests,
    successRate,
    fallbacks,
    fallbackRate,
    timeouts,
    timeoutsByLayer,
    errors,
    errorsByCode,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    firstTokenMs: { p50: percentile(firstTokens, 50) },
    actions: { total: actionRows.length, byType: actionsByType, byStatus: actionsByStatus },
    rateLimited,
    recentFailures: failures.slice(0, 10),
    alerts,
  }
}
