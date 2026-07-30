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

import { getGoogleRefreshTokenRecord } from '../google-token-store'

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
 * Find a usable credential for a tenant among its admins.
 *
 * Candidates are the tenant's admins: they are the users whose grant is most
 * likely to cover the analytics scopes, and the reports are addressed to them
 * anyway.
 *
 * Selection is scope-aware and deterministic, because the naive version
 * ("first one that mints, in whatever order Postgres returned") had two teeth:
 * minting succeeds for a credential missing every analytics scope, so a run
 * could silently produce a digest whose data sections were all 403 notes; and
 * the unordered admin list made that outcome vary run to run even though
 * nothing had changed.
 */
export async function resolveTenantToken(
  tenantId: string,
  candidateEmails: string[],
  /** Scopes the run actually needs; a candidate whose recorded grant is missing
   *  one is skipped. Omit to accept any credential that mints. */
  requiredScopes: string[] = [],
): Promise<MintedToken | null> {
  // Deterministic order. The admin list arrives unordered from Postgres, so
  // which credential a run picked varied between runs — and with it whether the
  // run produced real numbers or a digest full of 403 notes. Sorting makes a
  // failure reproducible instead of intermittent.
  const ordered = [...candidateEmails].sort((a, b) => a.localeCompare(b))

  // Two passes: prefer a candidate whose recorded scopes cover the run, but fall
  // back to any credential that mints rather than producing nothing. Granular
  // consent means an admin can hold Drive but not Analytics, and minting
  // succeeds either way — success carries no scope information at all, which is
  // why the stored scope string has to be consulted.
  for (const pass of ['scoped', 'any'] as const) {
    for (const email of ordered) {
      const stored = await getGoogleRefreshTokenRecord(email, tenantId)
      if (!stored?.refreshToken) continue

      if (pass === 'scoped' && requiredScopes.length && !coversScopes(stored.scope, requiredScopes)) {
        continue
      }

      const accessToken = await mintAccessToken(stored.refreshToken)
      if (accessToken) return { accessToken, email }

      console.warn(`[reports] stored token for ${email} did not mint; trying next candidate`)
    }
    if (!requiredScopes.length) break
  }
  return null
}

/**
 * Does a recorded grant cover every required scope?
 *
 * A NULL/absent scope string means "unknown, recorded before we captured it" —
 * treated as covering, because refusing it would lock out every pre-existing
 * grant. Exported for testing.
 */
export function coversScopes(scope: string | null | undefined, required: string[]): boolean {
  if (!scope) return true
  const granted = new Set(scope.split(/\s+/).filter(Boolean))
  return required.every(s => granted.has(s))
}
