/**
 * Shared Google-route auth + error mapping (audit P1-2).
 *
 * Every Google REST route resolved the OAuth token by hand and, in its catch
 * block, returned HTTP 500 for ANY failure. But `lib/google.ts` throws
 * `"Google API error <status>: ..."`, so an expired/revoked Google session
 * (upstream 401/403) surfaced to the browser as a 500 — and the client's
 * `useAuthErrorRecovery` only re-triggers sign-in on HTTP 401. The session
 * therefore went dark with an opaque error instead of self-healing.
 *
 * `googleApiErrorResponse` maps the thrown error back to the right status:
 *   - API not enabled in the Cloud project (accessNotConfigured) →
 *     403 `{ code: 'API_NOT_ENABLED' }` — an operator problem; never reauth
 *   - auth failures (401/403, invalid_grant) → 401 `{ reauth: true }`
 *   - transient upstream/network (429/5xx/timeout) → 502
 *   - everything else → its own 4xx, or 500
 */
import { NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import type { NextRequest } from 'next/server'
import { REFRESH_FATAL_ERROR, REFRESH_TRANSIENT_ERROR } from './auth-refresh'
import { toFault, faultResponse } from './fault'
import type { FaultCode } from './fault-codes'
import { reportFault } from './fault-report'
import { createLogger } from './logger'
import { safeRequestId } from './request-id'
import { parseTraceparent, gcpTraceFields, type TraceContext } from './trace-context'

/**
 * Map a thrown Google REST error message to the HTTP status the Hub should
 * return. Pure + exported for unit testing.
 */
export function mapGoogleErrorToStatus(message: string): number {
  const lower = message.toLowerCase()

  // A revoked/expired refresh or consent → re-auth.
  if (lower.includes('invalid_grant') || lower.includes('invalid credentials')) return 401

  // The first 3-digit token is the upstream HTTP status (lib/google.ts formats
  // messages as "Google API error <status>: ..." / "<op> <status>: ...").
  const m = message.match(/\b(\d{3})\b/)
  const status = m ? parseInt(m[1], 10) : 0

  // Google returns 403 for QUOTA and RATE LIMIT exhaustion as well as for
  // permission denial. Folding those into a re-auth 401 logged the user out
  // for burning through a quota — re-consenting cannot possibly fix a rate
  // limit, so this must be a retryable upstream failure instead.
  if (status === 403 && /rate ?limit|quota|userratelimit|backenderror|resource has been exhausted/i.test(message)) {
    return 502
  }

  if (status === 401 || status === 403) return 401
  if (status === 429 || (status >= 500 && status <= 599)) return 502
  if (/\b(timeout|timed out|network|fetch failed|econn|enotfound|socket)\b/i.test(message)) return 502
  if (status >= 400 && status <= 499) return status
  return 500
}

/* ── "API not enabled" (accessNotConfigured / SERVICE_DISABLED) ──
 *
 * Google answers 403 when the API itself is not enabled in the Cloud project
 * that owns the OAuth client (legacy reason `accessNotConfigured`, newer
 * ErrorInfo `SERVICE_DISABLED`, message "…API has not been used in project …
 * before or it is disabled. Enable it by visiting https://console.…").
 *
 * That failure READS like a permission problem — the body literally says
 * PERMISSION_DENIED — but it is an OPERATOR problem: only enabling the API in
 * the Cloud Console fixes it. Folding it into MISSING_SCOPE (or the generic
 * 403 → 401 reauth) sends the user through an OAuth consent that cannot
 * possibly help — the infinite "Authorize → consent → same error" loop the
 * OAuth runbook warns about, seen live on Settings → Analytics Sources when
 * the Analytics Admin API was never enabled. So both mappers classify it
 * FIRST and answer with a dedicated non-reauth code.
 */
const API_NOT_ENABLED_MARKERS =
  /accessnotconfigured|service_disabled|has not been used in project|enable it by visiting/i

/** True when a thrown Google 403 means "API not enabled in the Cloud project". */
export function isApiNotEnabledError(message: string): boolean {
  return /\b403\b/.test(message) && API_NOT_ENABLED_MARKERS.test(message)
}

/**
 * Google's message embeds an activation link ("Enable it by visiting
 * https://console.developers.google.com/apis/api/…?project=…"). Surface it so
 * an operator gets a one-click path to the fix. Client ids/project numbers are
 * not secret (they appear in every browser OAuth URL), so exposing the link is
 * safe.
 */
export function extractApiActivationUrl(message: string): string | undefined {
  return message.match(/https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"'\\<>]+/i)?.[0]
}

/** 403 { code: 'API_NOT_ENABLED' } — must never trigger reauth or re-consent. */
function apiNotEnabledResponse(err: unknown, featureLabel?: string): NextResponse {
  const raw = err instanceof Error ? err.message : ''
  const activationUrl = extractApiActivationUrl(raw)
  const lead = featureLabel ? `${featureLabel} is unavailable: a` : 'A'
  return NextResponse.json(
    {
      error:
        `${lead} Google API this feature needs is not enabled for the Hub's Google Cloud project. ` +
        'An operator must enable it in the Google Cloud Console — re-authorizing your Google account cannot fix this.',
      code: 'API_NOT_ENABLED',
      ...(activationUrl ? { activationUrl } : {}),
    },
    { status: 403 },
  )
}

/* ── Fault wiring (ERROR_REPORTING_2026-08-24.md §3 Layer 3) ──────────────────
 *
 * This one function was simultaneously the repo's largest silent-failure
 * cluster (31 call sites, zero log lines) and its largest raw-message leak
 * (the `{ error: message }` fallback shipped the raw upstream text to the
 * browser). Every branch now logs and reports a fault; the CLASSIFICATION
 * BODIES ARE UNCHANGED — API_NOT_ENABLED, MISSING_SCOPE, and `reauth: true`
 * encode real documented incidents (the infinite "Authorize → consent → same
 * error" loop) that client hooks key on verbatim. Only the fallback body
 * changes: a normalized problem+json instead of the raw upstream message,
 * with the mapped status preserved exactly.
 */

/** Context every call site now supplies, so a Google fault joins the pino
 *  seam and event_log.correlation_id instead of landing requestId: null. */
export interface GoogleFaultCtx {
  requestId: string
  /** Route PATTERN ('/api/google/gmail'), never a concrete path. */
  route: string
  method: string
  /** Cloud Run's traceparent, parsed — carried so the fault line and its log
   *  line nest under the request log like withFault's do. */
  trace?: TraceContext | null
}

/** The one-line ctx builder for route call sites. On middleware-matched paths
 *  the header was validated and set there; when absent, mint — an orphan id
 *  still joins this fault to its own pino line. */
export function googleRouteCtx(req: NextRequest | Request, route: string): GoogleFaultCtx {
  return {
    requestId: safeRequestId(req.headers.get('x-hub-request-id')),
    route,
    method: req.method,
    trace: parseTraceparent(req.headers.get('traceparent')),
  }
}

const log = createLogger('google-session')

/**
 * Map the classified status onto the fault taxonomy WITHOUT flattening the
 * classifier: the discriminators mirror mapGoogleErrorToStatus's own regexes,
 * so code and status can never disagree about what happened. `undefined`
 * lets toFault's structural recognition decide (SQLSTATEs, syscalls, …).
 */
function faultCodeForGoogleError(status: number, message: string): FaultCode | undefined {
  if (status === 502) {
    const m = message.match(/\b(\d{3})\b/)
    const upstream = m ? parseInt(m[1], 10) : 0
    if (upstream === 429 || /rate ?limit|quota|userratelimit|backenderror|resource has been exhausted/i.test(message)) {
      return 'rate_limited'
    }
    if (upstream >= 500) return 'upstream_5xx'
    if (/\b(timeout|timed out)\b/i.test(message)) return 'timeout_connect'
    return 'upstream_unavailable'
  }
  if (status >= 400 && status <= 499) return 'upstream_4xx'
  return undefined
}

/** Severity decides the log level — an expected reauth is not an ERROR line. */
function logGoogleFault(fault: ReturnType<typeof toFault>, trace: TraceContext | null): void {
  const fields = {
    requestId: fault.requestId,
    route: fault.route,
    method: fault.method,
    code: fault.code,
    faultId: fault.faultId,
    httpStatus: fault.httpStatus,
    ...gcpTraceFields(trace),
  }
  if (fault.severity === 'expected') log.info(fields, 'google api fault (expected)')
  else if (fault.severity === 'degraded') log.warn(fields, 'google api fault (degraded)')
  else log.error(fields, 'google api fault')
}

/** Normalize + log + report, KEEPING the caller's legacy response body. */
function reportGoogleFault(err: unknown, ctx: GoogleFaultCtx, code: FaultCode | undefined, httpStatus: number) {
  const fault = toFault(err, {
    layer: 'route',
    ...(code ? { code } : {}),
    route: ctx.route,
    method: ctx.method,
    module: 'google-session',
    requestId: ctx.requestId,
    httpStatus,
    context: { provider: 'google' },
  })
  const trace = ctx.trace ?? null
  logGoogleFault(fault, trace)
  reportFault(fault, { rawStack: err instanceof Error ? err.stack : null, trace })
  return fault
}

/** Build the Next response for a thrown Google REST error. */
export function googleApiErrorResponse(err: unknown, ctx: GoogleFaultCtx): NextResponse {
  const message = err instanceof Error ? err.message : 'Google API error'
  // Checked before the status mapping: the generic mapper folds 403 into a
  // reauth 401, and every consumer hook answers a reauth 401 with an automatic
  // signIn('google') — which cannot fix a disabled API and would loop.
  if (isApiNotEnabledError(message)) {
    reportGoogleFault(err, ctx, 'google_api_not_enabled', 403)
    return apiNotEnabledResponse(err)
  }
  const status = mapGoogleErrorToStatus(message)
  if (status === 401) {
    reportGoogleFault(err, ctx, 'auth_reauth_required', 401)
    return NextResponse.json(
      { error: 'Google session expired — please sign in again', reauth: true },
      { status: 401 },
    )
  }
  // The former raw-message leak: `{ error: message }` shipped upstream text
  // (which can embed emails, ids, even tokens) to the browser. The record
  // keeps the scrubbed detail; the client gets the fixed per-code message.
  // The mapped status is preserved exactly via httpStatus.
  const fault = reportGoogleFault(err, ctx, faultCodeForGoogleError(status, message), status)
  return faultResponse(fault, process.env.NODE_ENV === 'production')
}

/**
 * Error response for routes behind a NEWLY-added OAuth scope (Docs, Sheets,
 * Contacts). An existing user whose grant predates the scope gets a Google
 * 403 `insufficientPermissions` — which the generic mapper would fold into a
 * reauth 401. That works, but a dedicated `code: 'MISSING_SCOPE'` 403 lets the
 * client show a precise "grant access" prompt and re-consent, mirroring the
 * Chat routes. This runs BEFORE `googleApiErrorResponse`; anything that is NOT
 * a scope/permission 403 falls through to the generic mapper unchanged.
 *
 * IMPORTANT: only a genuine Google insufficient-scope 403 returns MISSING_SCOPE.
 * A bare 403 from role/gate/RBAC layers must NEVER reach here — re-consent
 * cannot fix those and would loop. This helper is for Google-upstream errors only.
 * API-not-enabled 403s are classified first for the same reason: Google labels
 * them PERMISSION_DENIED, but only the Cloud Console fixes them.
 */
export function googleWriteErrorResponse(err: unknown, scopeLabel: string, ctx: GoogleFaultCtx): NextResponse {
  const message = (err instanceof Error ? err.message : '').toLowerCase()
  if (isApiNotEnabledError(message)) {
    reportGoogleFault(err, ctx, 'google_api_not_enabled', 403)
    return apiNotEnabledResponse(err, scopeLabel)
  }
  const isScopeDenial =
    /\b403\b/.test(message) &&
    (message.includes('insufficient') ||
      message.includes('permission') ||
      message.includes('scope'))
  if (isScopeDenial) {
    reportGoogleFault(err, ctx, 'google_scope_missing', 403)
    return NextResponse.json(
      {
        error: `${scopeLabel} access hasn't been granted yet. Please re-authenticate to allow it.`,
        code: 'MISSING_SCOPE',
      },
      { status: 403 },
    )
  }
  return googleApiErrorResponse(err, ctx)
}

export type GoogleAuth =
  | { ok: true; accessToken: string }
  | { ok: false; response: NextResponse }

/**
 * Soft-degrade variant of {@link resolveGoogleAuth} for callers that must not
 * fail the request over a dead Google token — the chat route, which still
 * answers without Workspace data. Applies the SAME three checks (fatal refresh
 * error, missing token, expired-in-cookie access token) but returns a reason
 * string instead of an HTTP response, so the caller can tell the model WHY
 * Google data is missing rather than silently handing it a token that will 401
 * on every Google call.
 */
export type GoogleTokenState =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'transient' | 'reauth' | 'expired' }

export async function resolveGoogleAccessTokenLenient(req: NextRequest): Promise<GoogleTokenState> {
  const token = await getToken({ req })
  const accessToken = token?.accessToken as string | undefined

  if (token?.error === REFRESH_TRANSIENT_ERROR) return { ok: false, reason: 'transient' }
  if (!accessToken || token?.error === REFRESH_FATAL_ERROR) return { ok: false, reason: 'reauth' }
  if (isAccessTokenExpired(token?.accessTokenExpires)) return { ok: false, reason: 'expired' }

  return { ok: true, accessToken }
}

/**
 * Resolve the caller's Google OAuth access token, honoring a failed-refresh
 * signal.
 *
 * Two distinct failure shapes, because conflating them was logging people out
 * for no reason (see lib/auth-refresh.ts):
 *
 *  - `RefreshTransientError` — Google's token endpoint was briefly unreachable.
 *    The session and refresh token are INTACT. Answer 503 `{ reauth: false,
 *    retryable: true }` so the client retries instead of bouncing the user to
 *    the sign-in screen.
 *
 *  - missing token / `RefreshAccessTokenError` — the grant is genuinely dead.
 *    Answer 401 `{ reauth: true }`, the existing contract the client's
 *    auth-recovery path keys on.
 */
export async function resolveGoogleAuth(req: NextRequest): Promise<GoogleAuth> {
  const token = await getToken({ req })
  const accessToken = token?.accessToken as string | undefined

  if (token?.error === REFRESH_TRANSIENT_ERROR) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'Google is temporarily unreachable — retrying shortly. You are still signed in.',
          reauth: false,
          retryable: true,
        },
        { status: 503 },
      ),
    }
  }

  if (!accessToken || token?.error === REFRESH_FATAL_ERROR) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Google session expired — please sign in again', reauth: true },
        { status: 401 },
      ),
    }
  }

  // The cookie carries an access token that has already expired.
  //
  // This is reachable because `getToken()` only DECODES the cookie — it does
  // not run the `jwt` callback, so it cannot refresh anything. And the one
  // caller that could refresh, `getServerSession()`, discards its rotated
  // cookie in the App Router (no-op setCookie). Firing this dead token at
  // Google would earn a 401 that the client turns into a forced re-login.
  //
  // Instead, say so precisely: `refresh: true` tells the client to hit
  // `/api/auth/session` — the one path that DOES persist a rotated cookie —
  // and retry. `reauth: false` keeps it from bouncing to the sign-in screen
  // over a token that is one round-trip away from being valid.
  if (isAccessTokenExpired(token?.accessTokenExpires)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'Google access token expired — refreshing your session.',
          reauth: false,
          refresh: true,
        },
        { status: 401 },
      ),
    }
  }

  return { ok: true, accessToken }
}

/**
 * True when the recorded expiry is a real timestamp that has already passed.
 *
 * A missing / non-numeric expiry returns false — an older session that predates
 * this field must keep working rather than be declared expired.
 */
export function isAccessTokenExpired(accessTokenExpires: unknown, now = Date.now()): boolean {
  if (typeof accessTokenExpires !== 'number' || !Number.isFinite(accessTokenExpires)) return false
  return now >= accessTokenExpires
}
