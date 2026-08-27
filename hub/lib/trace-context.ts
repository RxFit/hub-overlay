/**
 * W3C traceparent parsing for Cloud Logging correlation
 * (ERROR_REPORTING_2026-08-24.md Layer 0).
 *
 * Cloud Run injects `traceparent` on every request. Emitting the trace as the
 * structured-log field `logging.googleapis.com/trace` (value
 * `projects/<project>/traces/<traceId>`) is the single field that nests the
 * container's own log lines under the request log in Logs Explorer.
 *
 * `traceparent` is PREFERRED over the legacy `X-Cloud-Trace-Context`: the
 * legacy header's span id is DECIMAL, while `LogEntry.spanId` must be 16-char
 * hex — reusing it verbatim silently breaks span linkage.
 *
 * Pure module, no imports — usable from the Edge runtime and Node alike.
 */

export interface TraceContext {
  /** 32 lowercase hex chars. */
  traceId: string
  /** 16 lowercase hex chars — the parent span. */
  spanId: string
}

// version "00": version(2) - traceId(32) - spanId(16) - flags(2). A future
// version may append fields after the flags, so the end is left open.
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}(?:$|-)/

/**
 * Parse a `traceparent` header. Returns null for anything malformed and for
 * the spec's all-zero "invalid" ids — a null simply means "no correlation",
 * never an error.
 */
export function parseTraceparent(header: string | null): TraceContext | null {
  if (!header) return null
  const m = TRACEPARENT_RE.exec(header.trim().toLowerCase())
  if (!m) return null
  const [, traceId, spanId] = m
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null
  return { traceId, spanId }
}

/** GCP resolves the project at ingest via these env vars; the fallback is the
 *  deploy target in .github/workflows/deploy.yml. */
function gcpProject(): string {
  return process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT ?? 'rxfit-automation'
}

/**
 * The structured-log fields Cloud Logging keys on. Spread into a pino call's
 * merge object or a hand-built JSON line; {} when there is no trace, so the
 * spread is always safe.
 */
export function gcpTraceFields(trace: TraceContext | null): Record<string, string> {
  if (!trace) return {}
  return {
    'logging.googleapis.com/trace': `projects/${gcpProject()}/traces/${trace.traceId}`,
    'logging.googleapis.com/spanId': trace.spanId,
  }
}
