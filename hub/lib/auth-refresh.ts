/**
 * OAuth refresh failure classification (PURE — no next-auth, no network).
 *
 * WHY THIS EXISTS
 * ---------------
 * The old `refreshAccessToken` treated EVERY failure as fatal: any non-OK
 * response — a Google 503, a 429, a dropped socket — wiped the access token and
 * stamped the session with `RefreshAccessTokenError`. Downstream that becomes a
 * 401 on every Google route, and the client's auth-recovery hook turns a 401
 * into `signIn('google')`. So one transient blip in Google's token endpoint
 * logged the user out of the whole Hub.
 *
 * That is wrong, and it is the single biggest contributor to spurious forced
 * re-logins: a refresh token stays perfectly valid across a network hiccup.
 * Only a handful of documented OAuth error codes actually mean the grant is
 * dead and the user must genuinely re-consent.
 *
 * Splitting the decision into a pure function keeps it unit-testable and keeps
 * the policy in one readable place.
 */

export type RefreshFailureKind =
  /** The grant is genuinely dead — only a real re-consent can fix it. */
  | 'fatal'
  /** Google/network was momentarily unavailable — the same token will work again. */
  | 'transient'

/** JWT `error` value for a transient failure. Must NOT trigger re-auth. */
export const REFRESH_TRANSIENT_ERROR = 'RefreshTransientError'
/** JWT `error` value for a dead grant. Triggers re-auth. */
export const REFRESH_FATAL_ERROR = 'RefreshAccessTokenError'

/**
 * OAuth 2.0 error codes that mean the refresh token itself is no longer usable.
 *
 * From RFC 6749 §5.2 plus Google's own documented values. `invalid_grant` is
 * the one that matters in practice — it is what Google returns for a revoked,
 * expired or password-reset-invalidated refresh token.
 */
const FATAL_OAUTH_ERRORS = new Set([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
  'invalid_request',
  'unsupported_grant_type',
])

/**
 * Decide whether a failed token refresh is fatal or transient.
 *
 * The rule, in precedence order:
 *  1. A documented fatal OAuth error code in the response body → fatal,
 *     whatever the HTTP status.
 *  2. 429 / 5xx / 408 → transient (rate limit or Google-side outage).
 *  3. No HTTP status at all (thrown fetch: DNS, TLS, socket, abort) → transient.
 *  4. Any other 4xx → fatal. A well-formed request that Google rejects with a
 *     client error is a real configuration/credential problem; retrying it
 *     forever would mask a broken deployment.
 *
 * @param status HTTP status of the token response, or 0/undefined if the
 *               request never completed.
 * @param body   Parsed JSON body of the token response, if any.
 */
export function classifyRefreshFailure(
  status: number | undefined,
  body?: unknown,
): RefreshFailureKind {
  const errorCode = (() => {
    if (!body || typeof body !== 'object') return ''
    const raw = (body as Record<string, unknown>).error
    return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  })()

  if (errorCode && FATAL_OAUTH_ERRORS.has(errorCode)) return 'fatal'

  if (!status) return 'transient'
  if (status === 408 || status === 429 || status >= 500) return 'transient'
  return 'fatal'
}

/**
 * True when a JWT error value means "the user must sign in again".
 *
 * A transient error explicitly does NOT qualify — the session is intact and the
 * next request retries the refresh. Server routes use this to choose between a
 * 401 (re-auth) and a 503 (retry shortly).
 */
export function isFatalAuthError(error: unknown): boolean {
  return error === REFRESH_FATAL_ERROR
}

/**
 * Backoff delays (ms) between in-request refresh retries.
 *
 * Deliberately tiny: this runs inside a user-facing request, so the whole retry
 * budget is ~1s. It exists to absorb a single dropped connection or a
 * momentary 503, not to wait out a real outage — that case falls through to the
 * transient verdict, which keeps the session alive and retries on the next
 * request anyway.
 */
export const REFRESH_RETRY_DELAYS_MS = [250, 750]

/**
 * How long to wait before the next refresh attempt after a transient failure.
 *
 * Written into `accessTokenExpires` so the very next request re-enters the
 * refresh path (rather than trusting a dead token) without hammering Google on
 * every single request during an outage.
 */
export const TRANSIENT_RETRY_BACKOFF_MS = 30_000

/**
 * Safety margin subtracted from the access token's expiry.
 *
 * Refreshing slightly early means an in-flight Google call can't land on the
 * far side of expiry and 401 — which the client would have escalated into a
 * re-login. Google access tokens last ~3600s, so 5 minutes is cheap insurance.
 */
export const TOKEN_EXPIRY_SKEW_MS = 5 * 60_000

/**
 * Is the current access token still safe to use?
 *
 * Defensive about the stored expiry: a missing / non-numeric / NaN value (an
 * older session, or a token minted before this field was written) must NOT be
 * read as "valid forever" — nor should it be read as "expired" in a way that
 * loses the session. It returns false, which routes the caller into the refresh
 * path, which is the safe direction.
 */
export function isAccessTokenFresh(
  accessTokenExpires: unknown,
  now: number = Date.now(),
): boolean {
  if (typeof accessTokenExpires !== 'number' || !Number.isFinite(accessTokenExpires)) return false
  return now < accessTokenExpires - TOKEN_EXPIRY_SKEW_MS
}
