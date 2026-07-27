import { describe, it, expect } from 'vitest'
import {
  classifyRefreshFailure,
  isAccessTokenFresh,
  isFatalAuthError,
  REFRESH_FATAL_ERROR,
  REFRESH_TRANSIENT_ERROR,
  TOKEN_EXPIRY_SKEW_MS,
} from './auth-refresh'

/**
 * The behavior this suite protects: a transient failure at Google's token
 * endpoint must NEVER be turned into a logout. Before this split, every refresh
 * failure wiped the access token and stamped RefreshAccessTokenError, which the
 * client escalated into signIn('google') — so one Google 503 signed the user
 * out of the whole Hub.
 */

describe('classifyRefreshFailure — fatal vs transient', () => {
  it('treats invalid_grant as fatal (revoked/expired refresh token)', () => {
    expect(classifyRefreshFailure(400, { error: 'invalid_grant' })).toBe('fatal')
  })

  it('treats invalid_client / unauthorized_client as fatal', () => {
    expect(classifyRefreshFailure(401, { error: 'invalid_client' })).toBe('fatal')
    expect(classifyRefreshFailure(400, { error: 'unauthorized_client' })).toBe('fatal')
  })

  it('is case- and whitespace-insensitive about the error code', () => {
    expect(classifyRefreshFailure(400, { error: '  Invalid_Grant ' })).toBe('fatal')
  })

  it('treats a fatal OAuth code as fatal even with an odd HTTP status', () => {
    // The body is authoritative: a proxy could rewrite the status.
    expect(classifyRefreshFailure(503, { error: 'invalid_grant' })).toBe('fatal')
  })

  it('treats Google 5xx as transient', () => {
    expect(classifyRefreshFailure(500)).toBe('transient')
    expect(classifyRefreshFailure(502, {})).toBe('transient')
    expect(classifyRefreshFailure(503, { error: 'backend_error' })).toBe('transient')
  })

  it('treats rate limiting and request timeout as transient', () => {
    expect(classifyRefreshFailure(429)).toBe('transient')
    expect(classifyRefreshFailure(408)).toBe('transient')
  })

  it('treats a thrown fetch (no HTTP status at all) as transient', () => {
    // DNS failure, TLS reset, dropped socket — the refresh token is fine.
    expect(classifyRefreshFailure(undefined)).toBe('transient')
    expect(classifyRefreshFailure(0)).toBe('transient')
  })

  it('treats an unexplained 4xx as fatal so a broken deploy is not retried forever', () => {
    expect(classifyRefreshFailure(403, {})).toBe('fatal')
  })

  it('ignores a non-string error field instead of crashing', () => {
    expect(classifyRefreshFailure(500, { error: { code: 5 } })).toBe('transient')
    expect(classifyRefreshFailure(500, 'not an object')).toBe('transient')
  })
})

describe('isFatalAuthError — only the fatal marker forces re-auth', () => {
  it('is true for the fatal marker', () => {
    expect(isFatalAuthError(REFRESH_FATAL_ERROR)).toBe(true)
  })

  it('is false for the transient marker — the session is still good', () => {
    expect(isFatalAuthError(REFRESH_TRANSIENT_ERROR)).toBe(false)
  })

  it('is false for no error', () => {
    expect(isFatalAuthError(undefined)).toBe(false)
    expect(isFatalAuthError(null)).toBe(false)
  })
})

describe('isAccessTokenFresh', () => {
  const now = 1_700_000_000_000

  it('is true well before expiry', () => {
    expect(isAccessTokenFresh(now + 60 * 60_000, now)).toBe(true)
  })

  it('is false after expiry', () => {
    expect(isAccessTokenFresh(now - 1, now)).toBe(false)
  })

  it('refreshes EARLY, inside the skew window, so an in-flight call cannot 401', () => {
    const justInsideSkew = now + TOKEN_EXPIRY_SKEW_MS - 1_000
    expect(isAccessTokenFresh(justInsideSkew, now)).toBe(false)
    expect(isAccessTokenFresh(now + TOKEN_EXPIRY_SKEW_MS + 1_000, now)).toBe(true)
  })

  it('treats a missing or non-numeric expiry as "refresh now", never as valid forever', () => {
    expect(isAccessTokenFresh(undefined, now)).toBe(false)
    expect(isAccessTokenFresh(null, now)).toBe(false)
    expect(isAccessTokenFresh('later', now)).toBe(false)
    expect(isAccessTokenFresh(NaN, now)).toBe(false)
    expect(isAccessTokenFresh(Infinity, now)).toBe(false)
  })
})
