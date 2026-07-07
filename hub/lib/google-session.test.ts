import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import {
  mapGoogleErrorToStatus,
  googleApiErrorResponse,
  resolveGoogleAuth,
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
})
