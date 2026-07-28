/**
 * Server-side access tokens for scheduled runs (SERVER-ONLY).
 *
 * A cron firing has no session — nobody is signed in at 7am on a Monday — so
 * the runner mints an access token from the refresh token the Hub already
 * stores for the user (`google_oauth_tokens`). This is the same credential and
 * the same token endpoint the interactive session refresh uses; only the
 * trigger differs.
 *
 * Side benefit worth stating: these periodic refreshes double as keep-alive
 * against Google's six-month-unused revocation of refresh tokens.
 */

import { getGoogleRefreshToken } from '../google-token-store'

export interface MintedToken {
  accessToken: string
  email: string
}

/**
 * Exchange a refresh token for an access token.
 * Returns null on any failure — a scheduled run should skip a tenant it cannot
 * authenticate, not crash the whole runner.
 */
export async function mintAccessToken(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    })
    if (!res.ok) {
      console.warn(`[reports] token refresh failed with ${res.status}`)
      return null
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string }
    return body.access_token ?? null
  } catch (err) {
    console.warn('[reports] token refresh threw:', err)
    return null
  }
}

/**
 * Find a usable credential for a tenant by trying its candidate emails in
 * order and returning the first that mints.
 *
 * Candidates are the tenant's admins: they are the users whose grant is most
 * likely to cover the analytics scopes, and the reports are addressed to them
 * anyway. A revoked or scope-reduced grant simply moves to the next candidate
 * rather than failing the tenant outright.
 */
export async function resolveTenantToken(
  tenantId: string,
  candidateEmails: string[],
): Promise<MintedToken | null> {
  for (const email of candidateEmails) {
    const refreshToken = await getGoogleRefreshToken(email, tenantId)
    if (!refreshToken) continue

    const accessToken = await mintAccessToken(refreshToken)
    if (accessToken) return { accessToken, email }

    console.warn(`[reports] stored token for ${email} did not mint; trying next candidate`)
  }
  return null
}
