import crypto from 'crypto'
import { NextResponse } from 'next/server'
import {
  type FaultCode,
  type FaultLayer,
  type FaultSeverity,
  type FaultBlame,
  USER_MESSAGES,
  classifyCode,
  statusForCode,
} from '@/lib/fault-codes'
import { isAppError } from '@/lib/errors'
import { fingerprintFault, inAppFrames, type FingerprintStrategy } from '@/lib/fault-fingerprint'
import { matchFingerprintRule } from '@/lib/fault-fingerprint-rules'

/**
 * The canonical fault record and its ONE normalizer, `toFault()`
 * (ERROR_REPORTING_2026-08-24.md §4).
 *
 * PURE MODULE: no I/O, no Date.now() — `ts` is stamped by reportFault()
 * (lib/fault-report.ts), never here, so everything in this file unit-tests
 * with fixtures, mirroring toRunRow (lib/runs.ts) and toAuditRow
 * (lib/ai-audit.ts).
 *
 * PII: `message`, `stack` and `causeChain` are the only free-text fields in
 * the record, and every one of them passes through scrubFreeText() INSIDE
 * this module — no code path can construct a FaultRecord with unscrubbed
 * text. Key-based denylists never look inside a string, which is why the
 * free-text pass exists at all (stack traces routinely embed request URLs,
 * SQL, and credentials). Enforced by lib/fault-redact.test.ts.
 */

/* ── The record ──────────────────────────────────────────────────────────── */

export interface FaultRecord {
  /** 'HUB-' + 8 base32 chars — RFC 9457 `instance`. The string an operator
   *  quotes and a user pastes into a support message. Also returned as the
   *  `x-hub-fault-id` response header so it survives a body-less failure. */
  faultId: string
  /** 16-hex grouping key — two occurrences of the same bug share it. */
  fingerprint: string
  /** Which rung of the cascade fired; without it, fingerprint tuning is blind. */
  fingerprintStrategy: FingerprintStrategy
  /** ISO-8601 UTC. Stamped by reportFault(), not by the pure mapper. */
  ts: string
  /** THE correlation spine: pino correlationId, telemetry requestId,
   *  ai_runs.request_id and event_log.correlation_id, all one value. */
  requestId: string | null
  /** dispatch_jobs / ai_runs / tool_runs joins, when known. */
  jobId: string | null
  runId: string | null
  /** Which mechanism caught it. */
  layer: FaultLayer
  /** Route PATTERN only ('/api/orgs/[orgId]/founder-lens'), never a concrete
   *  path — a PII control, a cardinality control, and a fingerprint-stability
   *  control at once. */
  route: string | null
  method: string | null
  /** The pino `module` binding, so a fault and its surrounding log lines
   *  filter together in Logs Explorer. */
  module: string | null
  /** Closed, low-cardinality union — the ONLY metric/alert dimension. */
  code: FaultCode
  /** Constructor name, ≤64 chars. High-cardinality: log-only, never a label. */
  errName: string | null
  /** OPERATOR-facing. Single-lined, scrubbed, ≤300 chars (the flattenError
   *  contract from lib/runs.ts). Never appears in a response body. */
  message: string
  /** Fixed per code — the ONLY text a client ever sees. */
  userMessage: string
  /** ≤8 in-app frames, repo-relative, LINE NUMBERS STRIPPED, scrubbed.
   *  Persisted only — never in a response body. */
  stack: string | null
  /** `err.cause` walked EXPLICITLY to depth 3. Required because `cause` is
   *  non-enumerable: JSON.stringify drops the whole chain silently. */
  causeChain: Array<{ name: string; message: string }>
  /** FOUR-valued, never a boolean. `cancelled` is a user pressing stop and
   *  is NOT an error; collapsing these makes the error rate measure user
   *  behavior. */
  outcome: 'error' | 'incomplete' | 'cancelled' | 'degraded'
  severity: FaultSeverity
  blame: FaultBlame
  /** True when the code EXPECTED this failure — the operational/programmer
   *  error split. */
  isExpected: boolean
  /** Decided once at the boundary where the failure's meaning is known. */
  isRetryable: boolean
  /** Retries recorded on the TERMINAL record, never as N error rows. */
  retryCount: number
  /** True when a fallback substituted an empty/degraded result — the
   *  silent-failure marker. */
  partial: boolean
  /** Status actually returned. 200 IS LEGAL: the mid-stream signature. */
  httpStatus: number | null
  /** hashEmail() 12-hex only (lib/observability.ts) — never a raw address. */
  userHash: string | null
  /** Optional explicit tenant; when absent, recordEvent() resolves it via
   *  getTenantId(), exactly as every other event_log write does. */
  tenantId?: string
  /** process.env.GIT_SHA — deliberately NOT in the fingerprint. */
  release: string
  /** Cloud Run revision (K_REVISION), when present. */
  revision: string | null
  env: string
  /** ALLOWLIST-built, ≤10 keys, scalars only, ≤200 chars each. */
  context: Record<string, string | number | boolean> | null
  /** Zod paths only — NEVER values. Safe for the response body. */
  issues?: Array<{ path: string; message: string }>
  /** Set when this record itself was shed — drop accounting (§8). */
  droppedReason: 'rate_limit' | 'ring_full' | 'payload_too_large' | null
}

/** What toFault() produces: everything but the timestamp reportFault stamps. */
export type FaultDraft = Omit<FaultRecord, 'ts'>

/* ── Identity ────────────────────────────────────────────────────────────── */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** 'HUB-' + base32(5 random bytes), e.g. HUB-K7QF2M9A. */
export function newFaultId(): string {
  const bytes = crypto.randomBytes(5)
  let bits = 0
  let acc = 0
  let out = ''
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32[(acc >> bits) & 31]
    }
  }
  return `HUB-${out}`
}

/* ── Free-text scrubbing ─────────────────────────────────────────────────── */

/**
 * Ordered redaction pass for `message`/`stack`/`causeChain` text. Most
 * specific first — credentials inside URLs are tokenized before the email
 * rule can half-match them.
 */
const SCRUBBERS: Array<[RegExp, string]> = [
  // scheme://user:pass@host — remove the credential AND the '@'
  [/(\w+:\/\/)[^\s/@]+@/g, '$1<credentials>'],
  // key=value / key: value secret shapes (Sentry's denylist family)
  [/\b(password|passwd|secret|credentials?|api[_-]?key|apikey|auth|token|bearer)\s*[=:]\s*[^\s"',;]+/gi, '$1=<redacted>'],
  [/\bBearer\s+[^\s"']+/gi, '<token>'],
  [/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g, '<token>'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '<token>'],
  [/\bAIza[A-Za-z0-9_-]{8,}/g, '<token>'],
  // query strings anywhere (chunk URLs in stacks carry ?token=…)
  [/\?[\w=&%~.+-]{2,}/g, ''],
  // NOTE: no blanket '@' rule — stack frames are `fn@repoRelativeFile` by
  // the fingerprint spec, so only the EMAIL shape (user@host.tld) is
  // redacted; a frame's `@lib/...` has no dot-TLD and survives.
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>'],
]

/** Redact secrets/PII out of free text. Idempotent; never throws. */
export function scrubFreeText(raw: string): string {
  let out = raw
  for (const [re, replacement] of SCRUBBERS) out = out.replace(re, replacement)
  return out
}

/** Single-line + truncate at `max` with an ellipsis — the exact contract of
 *  the private flattenError in lib/runs.ts, exported here for reuse. */
export function flattenError(msg: string | null | undefined, max = 300): string | null {
  if (!msg) return null
  const flat = msg.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/* ── Context allowlist ───────────────────────────────────────────────────── */

/** Allowlist-first is the only posture that survives a library adding a field
 *  nobody anticipated; a denylist fails open on `passwd2` or `X-Api-Secret`.
 *  Anything not listed is DROPPED, not redacted. */
const ALLOWED_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  'route', 'method', 'status', 'provider', 'model', 'jobId', 'runId', 'kind',
  'attempt', 'bytesSent', 'finishReason', 'retryCount', 'key', 'tag',
])

const MAX_CONTEXT_KEYS = 10
const MAX_CONTEXT_VALUE_CHARS = 200

export function scrubContext(
  ctx: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean> | null {
  if (!ctx || typeof ctx !== 'object') return null
  const out: Record<string, string | number | boolean> = {}
  let kept = 0
  for (const [k, v] of Object.entries(ctx)) {
    if (kept >= MAX_CONTEXT_KEYS) break
    if (!ALLOWED_CONTEXT_KEYS.has(k)) continue
    if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v
      kept++
    } else if (typeof v === 'string') {
      out[k] = scrubFreeText(v.slice(0, MAX_CONTEXT_VALUE_CHARS))
      kept++
    }
  }
  return kept > 0 ? out : null
}

/* ── Cause chain ─────────────────────────────────────────────────────────── */

/** Walk `err.cause` to depth 3, scrubbing each message. Explicit walk because
 *  `cause` is non-enumerable and serializers drop it silently. */
export function causeChain(err: unknown, depth = 3): Array<{ name: string; message: string }> {
  const out: Array<{ name: string; message: string }> = []
  let cur: unknown = err instanceof Error ? err.cause : undefined
  while (cur !== undefined && cur !== null && out.length < depth) {
    if (cur instanceof Error) {
      out.push({
        name: (cur.name || 'Error').slice(0, 64),
        message: scrubFreeText(flattenError(cur.message) ?? ''),
      })
      cur = cur.cause
    } else {
      out.push({ name: 'NonError', message: scrubFreeText(flattenError(String(cur)) ?? '') })
      break
    }
  }
  return out
}

/* ── Normalization ───────────────────────────────────────────────────────── */

export interface FaultContext {
  faultId?: string
  requestId?: string | null
  layer: FaultLayer
  route?: string | null
  method?: string | null
  module?: string | null
  /** Caller override — the boundary knows the failure's meaning best. */
  code?: FaultCode
  outcome?: FaultRecord['outcome']
  severity?: FaultSeverity
  partial?: boolean
  retryCount?: number
  httpStatus?: number | null
  userHash?: string | null
  tenantId?: string
  jobId?: string | null
  runId?: string | null
  context?: Record<string, unknown>
  fingerprint?: string
  /** For faults arriving pre-shaped (the client sink): a stack string to use
   *  when `err` carries none. */
  stack?: string | null
}

interface Recognized {
  code: FaultCode
  cancelled?: boolean
  issues?: Array<{ path: string; message: string }>
  explicitFingerprint?: string
  extraContext?: Record<string, unknown>
  retryableOverride?: boolean
  userMessageOverride?: string
}

/** Node syscall codes that mean "the dependency was unreachable". */
const SYSCALL_UNAVAILABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN'])

function errCode(err: unknown): string | null {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' ? code : null
}

/**
 * Classification lives in EXACTLY one place — here. Recognition is
 * STRUCTURAL throughout (names and shapes, never instanceof against imported
 * classes): a ZodError from `zod/v4` is not instanceof the root `zod`'s
 * class, and bundlers can duplicate modules; shape checks survive both.
 */
function recognize(err: unknown): Recognized {
  // 1. AppError — the thrower already decided everything.
  if (isAppError(err)) {
    return {
      code: err.code,
      explicitFingerprint: err.fingerprint,
      extraContext: err.context,
      retryableOverride: err.retryable,
      userMessageOverride: err.userMessage,
    }
  }
  if (err instanceof Error) {
    // 2. ZodError, structurally. Keep issues[].path ONLY — never .input or
    //    .received, which can carry credentials.
    if (err.name === 'ZodError' && Array.isArray((err as unknown as { issues?: unknown }).issues)) {
      const issues = ((err as unknown as { issues: Array<{ path?: unknown; message?: unknown }> }).issues)
        .slice(0, 20)
        .map((i) => ({
          path: Array.isArray(i.path) ? i.path.map(String).join('.').slice(0, 120) : '',
          message: typeof i.message === 'string' ? scrubFreeText(i.message.slice(0, 200)) : '',
        }))
      return { code: 'validation_failed', issues }
    }
    // 3. Client abort — NOT an error, or the error rate measures how often
    //    users press stop.
    if (err.name === 'AbortError') {
      return { code: 'internal', cancelled: true }
    }
    // 4. The repo's existing ad-hoc classes, by name (retrofit is Phase 2).
    if (err.name === 'CircuitOpenError') return { code: 'upstream_breaker_open' }
    if (err.name === 'InvalidPageTokenError') return { code: 'validation_failed' }
    if (err.name === 'LoopDetectedError') return { code: 'invariant_violation' }
  }
  // 5. Postgres SQLSTATEs (the postgres.js driver sets err.code).
  const code = errCode(err) ?? errCode((err as Error | undefined)?.cause)
  if (code) {
    if (code === '42P01') return { code: 'db_table_missing' }
    if (/^23\d{3}$/.test(code)) return { code: 'db_constraint' }
    if (/^(08|53|57)\d{3}$/.test(code) || /^XX\d{3}$/.test(code)) return { code: 'db_error' }
    // 6. Node syscall errors — the dependency, not us.
    if (SYSCALL_UNAVAILABLE.has(code)) return { code: 'upstream_unavailable' }
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return { code: 'timeout_connect' }
  }
  // 7. The system was surprised.
  return { code: 'internal' }
}

/** Normalize ANY thrown value into a FaultDraft. Never throws. */
export function toFault(err: unknown, ctx: FaultContext): FaultDraft {
  const recognized = recognize(err)
  const code = ctx.code ?? recognized.code
  const classification = classifyCode(code)

  const rawMessage = err instanceof Error ? err.message : String(err)
  const message = scrubFreeText(flattenError(rawMessage) ?? 'unknown error')
  const rawStack = (err instanceof Error ? err.stack : null) ?? ctx.stack ?? null
  const errName = err instanceof Error ? (err.name || 'Error').slice(0, 64) : null

  const explicit =
    ctx.fingerprint ??
    recognized.explicitFingerprint ??
    matchFingerprintRule(code, ctx.route)

  const { fingerprint, strategy } = fingerprintFault({
    code,
    layer: ctx.layer,
    route: ctx.route ?? null,
    errName,
    message,
    stack: rawStack,
    explicit,
  })

  const cancelled = recognized.cancelled === true
  const severity: FaultSeverity = cancelled ? 'expected' : (ctx.severity ?? classification.severity)
  const outcome: FaultRecord['outcome'] = cancelled
    ? 'cancelled'
    : (ctx.outcome ?? (severity === 'degraded' ? 'degraded' : 'error'))

  // Scrubbed 8-frame stack for the record — same frame reducer as the
  // fingerprint (fn@repo-relative-file, line numbers already stripped), just
  // deeper.
  const stack = rawStack ? scrubFreeText(inAppFrames(rawStack, 8).join('\n')) || null : null

  return {
    faultId: ctx.faultId ?? newFaultId(),
    fingerprint,
    fingerprintStrategy: strategy,
    requestId: ctx.requestId ?? null,
    jobId: ctx.jobId ?? null,
    runId: ctx.runId ?? null,
    layer: ctx.layer,
    route: ctx.route ?? null,
    method: ctx.method ?? null,
    module: ctx.module ?? null,
    code,
    errName,
    message,
    userMessage: recognized.userMessageOverride ?? USER_MESSAGES[code],
    stack,
    causeChain: causeChain(err),
    outcome,
    severity,
    blame: cancelled ? 'cancelled' : classification.blame,
    isExpected: cancelled ? true : classification.isExpected,
    isRetryable: recognized.retryableOverride ?? classification.isRetryable,
    retryCount: ctx.retryCount ?? 0,
    partial: ctx.partial ?? false,
    httpStatus: ctx.httpStatus ?? (cancelled ? null : statusForCode(code)),
    userHash: ctx.userHash ?? null,
    ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
    release: process.env.GIT_SHA ?? 'unknown',
    revision: process.env.K_REVISION ?? null,
    env: process.env.NODE_ENV ?? 'development',
    context: scrubContext({ ...recognized.extraContext, ...ctx.context }),
    ...(recognized.issues ? { issues: recognized.issues } : {}),
    droppedReason: null,
  }
}

/* ── The response body ───────────────────────────────────────────────────── */

/**
 * RFC 9457 problem+json. `details` (the operator message) is included ONLY
 * outside production — this generalizes lib/chat-error.ts, today the repo's
 * only NODE_ENV-gated error body. Every response also carries x-hub-fault-id
 * and x-hub-request-id headers so the identifier survives a body-less
 * failure.
 */
export function faultResponse(fault: FaultDraft, isProd: boolean): NextResponse {
  const status = fault.httpStatus ?? statusForCode(fault.code)
  const body: Record<string, unknown> = {
    type: `https://hub.casatrejo.com/errors/${fault.code}`,
    title: USER_MESSAGES[fault.code],
    status,
    detail: fault.userMessage,
    instance: fault.faultId,
    code: fault.code,
    requestId: fault.requestId,
    // Back-compat: every existing client branch keys on `error`.
    error: fault.userMessage,
  }
  if (fault.issues && fault.issues.length > 0) body.issues = fault.issues
  if (!isProd) body.details = fault.message
  const headers: Record<string, string> = {
    'content-type': 'application/problem+json',
    'x-hub-fault-id': fault.faultId,
  }
  if (fault.requestId) headers['x-hub-request-id'] = fault.requestId
  return NextResponse.json(body, { status, headers })
}
