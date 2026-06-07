import crypto from 'crypto'
import { createLogger } from '@/lib/logger'

const log = createLogger('google-auth')

interface ServiceAccountKey {
  client_email: string
  private_key: string
  token_uri: string
}

/* ── Scope-Based Token Cache ── */

interface CachedToken {
  token: string
  expiresAt: number
}

const tokenCache = new Map<string, CachedToken>()

/**
 * Retrieve a Google access token using the GCP service account key.
 *
 * Features:
 * - Scope-based caching: different scopes get different cached tokens
 * - 60-second expiry buffer to prevent using nearly-expired tokens
 * - Defensive quote stripping for .env copy-paste errors
 *
 * @param scope Google API scope (e.g. 'https://www.googleapis.com/auth/cloud-platform')
 * @returns Access token or null if auth fails
 */
export async function getServiceAccountAccessToken(scope: string): Promise<string | null> {
  let keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyJson) {
    log.warn('GOOGLE_SERVICE_ACCOUNT_KEY is not set')
    return null
  }

  // Defensive: strip wrapping single/double quotes (common .env copy-paste error)
  keyJson = keyJson.replace(/^['"]|['"]$/g, '')

  // Return cached token if still valid (with 60s buffer)
  const cached = tokenCache.get(scope)
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.token
  }

  try {
    const key: ServiceAccountKey = JSON.parse(keyJson)

    // Build JWT Header and Claim Set
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const claimSet = {
      iss: key.client_email,
      scope,
      aud: key.token_uri,
      iat: now,
      exp: now + 3600,
    }
    const payload = Buffer.from(JSON.stringify(claimSet)).toString('base64url')

    // Sign JWT using private key
    const signer = crypto.createSign('RSA-SHA256')
    signer.update(`${header}.${payload}`)
    const signature = signer.sign(key.private_key, 'base64url')
    const jwt = `${header}.${payload}.${signature}`

    // Exchange JWT for access token
    const res = await fetch(key.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      log.error({ status: res.status, body }, 'Token exchange failed')
      return null
    }

    const data = await res.json() as { access_token: string; expires_in: number }

    // Cache with scope-based key
    tokenCache.set(scope, {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    })

    log.info({ scope, expiresIn: data.expires_in }, 'Service account token acquired')
    return data.access_token
  } catch (err) {
    log.error({ err }, 'Service account auth error')
    return null
  }
}
