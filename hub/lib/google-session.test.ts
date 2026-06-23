import { describe, it, expect } from 'vitest'
import { mapGoogleErrorToStatus } from './google-session'

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
