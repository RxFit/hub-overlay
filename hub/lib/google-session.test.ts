import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import {
  mapGoogleErrorToStatus,
  googleApiErrorResponse,
  googleWriteErrorResponse,
  resolveGoogleAuth,
  resolveGoogleAccessTokenLenient,
} from './google-session'

const { getTokenMock } = vi.hoisted(() => ({ getTokenMock: vi.fn() }))
vi.mock('next-auth/jwt', () => ({ getToken: getTokenMock }))

/* P1-2: an expired/revoked Google session must surface as 401 (so the client
   re-auths), transient upstream failures as 502, never an opaque 500. */
describe('mapGoogleErrorToStatus', () => {
  it('maps upstream auth failures (401/403) to 401', () => {
    expect(mapGoogleErrorToStatus('Google API error 401: Invalid Credentials')).toBe(401)
    expect(mapGoogleErrorToStatus('Google API error 403: insufficientPermissions')).toBe(401)
    expect(mapGoogleErrorToStatus('deleteCalendarEvent 401: Unauthorized')).toBe(401)
    expect(mapGoogleErrorToStatus('Token refresh failed: invalid_grant')).toBe(401)
  })

  it('maps transient upstream/network failures to 502', () => {
    expect(mapGoogleErrorToStatus('Google API error 500: backend error')).toBe(502)
    expect(mapGoogleErrorToStatus('Google API error 503: unavailable')).toBe(502)
    expect(mapGoogleErrorToStatus('Google API error 429: rate limited')).toBe(502)
    expect(mapGoogleErrorToStatus('fetch failed')).toBe(502)
    expect(mapGoogleErrorToStatus('request timed out')).toBe(502)
  })

  it('preserves other client errors and defaults unknowns to 500', () => {
    expect(mapGoogleErrorToStatus('Google API error 404: not found')).toBe(404)
    expect(mapGoogleErrorToStatus('Google API error 400: bad request')).toBe(400)
    expect(mapGoogleErrorToStatus('Unknown error')).toBe(500)
  })

  it('reads the status code, not an incidental number in the body', () => {
    // First 3-digit token is the upstream status; trailing body numbers ignored.
    expect(mapGoogleErrorToStatus('Google API error 401: user 403 lacks scope 200')).toBe(401)
  })
})

/* The newly-scoped write routes (Docs/Sheets/Contacts) must return a
   discriminating 403 { code: 'MISSING_SCOPE' } ONLY for genuine Google
   insufficient-scope errors — so the client re-consents on those and NEVER on
   a bare RBAC/gate 403 (which re-consent can't fix and would loop on). */
describe('googleWriteErrorResponse', () => {
  it('returns 403 { code: MISSING_SCOPE } for a Google insufficient-scope error', async () => {
    const res = googleWriteErrorResponse(
      new Error('Google API error 403: Request had insufficient authentication scopes.'),
      'Google Docs',
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('MISSING_SCOPE')
    expect(body.error).toMatch(/Google Docs/)
  })

  it('does NOT tag a 403 that lacks a scope/permission reason (falls through to generic mapping)', async () => {
    // A bare 403 with no insufficient/permission/scope wording is not a scope
    // denial — it must not become MISSING_SCOPE. (Generic mapper folds Google
    // 403 → 401 reauth; the key assertion is that it's not MISSING_SCOPE.)
    const res = googleWriteErrorResponse(new Error('Google API error 403: rateLimitExceeded'), 'Google Sheets')
    const body = await res.json()
    expect(body.code).toBeUndefined()
  })

  it('passes non-403 failures straight through to the generic mapper', async () => {
    const res = googleWriteErrorResponse(new Error('Google API error 404: not found'), 'Google Docs')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBeUndefined()
    expect(body.error).toBe('Google API error 404: not found')
  })
})

describe('googleApiErrorResponse', () => {
  it('returns a 401 { reauth: true } envelope for auth failures', async () => {
    const res = googleApiErrorResponse(new Error('Token refresh failed: invalid_grant'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.reauth).toBe(true)
    expect(body.error).toMatch(/sign in again/i)
  })

  it('propagates the thrown message for non-auth failures at the mapped status', async () => {
    const res = googleApiErrorResponse(new Error('Google API error 404: event not found'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Google API error 404: event not found')
    expect(body.reauth).toBeUndefined()
  })

  it('handles non-Error throwables with a generic 500', async () => {
    const res = googleApiErrorResponse('something odd')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Google API error')
  })
})

describe('resolveGoogleAuth', () => {
  const req = {} as NextRequest

  beforeEach(() => {
    getTokenMock.mockReset()
  })

  it('returns the access token when the session is healthy', async () => {
    getTokenMock.mockResolvedValueOnce({ accessToken: 'ya29.valid' })
    const auth = await resolveGoogleAuth(req)
    expect(auth).toEqual({ ok: true, accessToken: 'ya29.valid' })
  })

  it('returns a ready-made 401 reauth response when there is no token', async () => {
    getTokenMock.mockResolvedValueOnce(null)
    const auth = await resolveGoogleAuth(req)
    expect(auth.ok).toBe(false)
    if (!auth.ok) {
      expect(auth.response.status).toBe(401)
      const body = await auth.response.json()
      expect(body.reauth).toBe(true)
    }
  })

  it('treats a failed token refresh as unauthenticated even if a stale token is present', async () => {
    getTokenMock.mockResolvedValueOnce({
      accessToken: 'ya29.stale',
      error: 'RefreshAccessTokenError',
    })
    const auth = await resolveGoogleAuth(req)
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.response.status).toBe(401)
  })

  it('answers 503 retryable — NOT 401 reauth — for a transient refresh failure', async () => {
    // A Google outage must never log the user out: the session and refresh
    // token are both intact and the next request retries.
    getTokenMock.mockResolvedValueOnce({
      accessToken: 'ya29.something',
      error: 'RefreshTransientError',
    })
    const auth = await resolveGoogleAuth(req)
    expect(auth.ok).toBe(false)
    if (!auth.ok) {
      expect(auth.response.status).toBe(503)
      const body = await auth.response.json()
      expect(body.reauth).toBe(false)
      expect(body.retryable).toBe(true)
    }
  })

  it('asks the client to REFRESH (not re-login) when the cookie holds an expired access token', async () => {
    // getToken() only decodes the cookie, and getServerSession() discards the
    // token it rotates in the App Router — so a stale access token sits in the
    // cookie until /api/auth/session runs. Handing it to Google would earn a
    // 401 the client escalates into a forced sign-in.
    getTokenMock.mockResolvedValueOnce({
      accessToken: 'ya29.expired',
      accessTokenExpires: Date.now() - 60_000,
    })
    const auth = await resolveGoogleAuth(req)
    expect(auth.ok).toBe(false)
    if (!auth.ok) {
      expect(auth.response.status).toBe(401)
      const body = await auth.response.json()
      expect(body.refresh).toBe(true)
      expect(body.reauth).toBe(false)
    }
  })

  it('passes through a token whose expiry is still in the future', async () => {
    getTokenMock.mockResolvedValueOnce({
      accessToken: 'ya29.fresh',
      accessTokenExpires: Date.now() + 30 * 60_000,
    })
    expect(await resolveGoogleAuth(req)).toEqual({ ok: true, accessToken: 'ya29.fresh' })
  })

  it('passes through a legacy session that records no expiry at all', async () => {
    // Sessions minted before accessTokenExpires was written must keep working
    // rather than be declared expired.
    getTokenMock.mockResolvedValueOnce({ accessToken: 'ya29.legacy' })
    expect(await resolveGoogleAuth(req)).toEqual({ ok: true, accessToken: 'ya29.legacy' })
  })
})

describe('mapGoogleErrorToStatus — quota 403s are not credential failures', () => {
  it('maps a rate-limit 403 to a retryable 502 instead of a reauth 401', () => {
    // Re-consenting cannot fix a quota; treating it as an auth failure logged
    // the user out for using the app too fast.
    expect(mapGoogleErrorToStatus('Google API error 403: rateLimitExceeded')).toBe(502)
    expect(mapGoogleErrorToStatus('Google API error 403: Quota exceeded for quota metric')).toBe(502)
    expect(mapGoogleErrorToStatus('Google API error 403: userRateLimitExceeded')).toBe(502)
  })

  it('still maps a genuine permission 403 to a reauth 401', () => {
    expect(mapGoogleErrorToStatus('Google API error 403: insufficientPermissions')).toBe(401)
  })
})

/* The chat route must apply the SAME token checks as the panel routes, but
   soft — it still answers without Workspace data. Before this existed, a bare
   getToken() handed dead tokens to every Google consumer in chat and their
   failures were silently swallowed: all Drive/Gmail/Calendar data vanished
   from the model's context, which users experienced as "the AI can't see any
   Google Drive files". */
describe('resolveGoogleAccessTokenLenient', () => {
  const req = {} as NextRequest

  beforeEach(() => {
    getTokenMock.mockReset()
  })

  it('returns the access token when the session is healthy', async () => {
    getTokenMock.mockResolvedValueOnce({ accessToken: 'ya29.ok' })
    expect(await resolveGoogleAccessTokenLenient(req)).toEqual({ ok: true, accessToken: 'ya29.ok' })
  })

  it('reports reauth when there is no token at all', async () => {
    getTokenMock.mockResolvedValueOnce(null)
    expect(await resolveGoogleAccessTokenLenient(req)).toEqual({ ok: false, reason: 'reauth' })
  })

  it('reports reauth for a fatal refresh failure even with a stale token present', async () => {
    getTokenMock.mockResolvedValueOnce({ accessToken: 'ya29.stale', error: 'RefreshAccessTokenError' })
    expect(await resolveGoogleAccessTokenLenient(req)).toEqual({ ok: false, reason: 'reauth' })
  })

  it('reports transient — NOT reauth — for a transient refresh failure', async () => {
    getTokenMock.mockResolvedValueOnce({ accessToken: 'ya29.x', error: 'RefreshTransientError' })
    expect(await resolveGoogleAccessTokenLenient(req)).toEqual({ ok: false, reason: 'transient' })
  })

  it('reports expired for a cookie holding an already-expired access token', async () => {
    getTokenMock.mockResolvedValueOnce({
      accessToken: 'ya29.dead',
      accessTokenExpires: Date.now() - 60_000,
    })
    expect(await resolveGoogleAccessTokenLenient(req)).toEqual({ ok: false, reason: 'expired' })
  })

  it('passes through a legacy session that records no expiry at all', async () => {
    getTokenMock.mockResolvedValueOnce({ accessToken: 'ya29.legacy' })
    expect(await resolveGoogleAccessTokenLenient(req)).toEqual({ ok: true, accessToken: 'ya29.legacy' })
  })
})
