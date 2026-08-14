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

/** Build the Next response for a thrown Google REST error. */
export function googleApiErrorResponse(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : 'Google API error'
  // Checked before the status mapping: the generic mapper folds 403 into a
  // reauth 401, and every consumer hook answers a reauth 401 with an automatic
  // signIn('google') — which cannot fix a disabled API and would loop.
  if (isApiNotEnabledError(message)) return apiNotEnabledResponse(err)
  const status = mapGoogleErrorToStatus(message)
  if (status === 401) {
    return NextResponse.json(
      { error: 'Google session expired — please sign in again', reauth: true },
      { status: 401 },
    )
  }
  return NextResponse.json({ error: message }, { status })
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
export function googleWriteErrorResponse(err: unknown, scopeLabel: string): NextResponse {
  const message = (err instanceof Error ? err.message : '').toLowerCase()
  if (isApiNotEnabledError(message)) return apiNotEnabledResponse(err, scopeLabel)
  const isScopeDenial =
    /\b403\b/.test(message) &&
    (message.includes('insufficient') ||
      message.includes('permission') ||
      message.includes('scope'))
  if (isScopeDenial) {
    return NextResponse.json(
      {
        error: `${scopeLabel} access hasn't been granted yet. Please re-authenticate to allow it.`,
        code: 'MISSING_SCOPE',
      },
      { status: 403 },
    )
  }
  return googleApiErrorResponse(err)
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
