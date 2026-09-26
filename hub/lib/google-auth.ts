import crypto from 'crypto'
import { swallow } from '@/lib/swallow'

export interface ServiceAccountKey {
  client_email: string
  private_key: string
  token_uri: string
  /** Numeric OAuth client id — what Google Admin's domain-wide delegation form asks for. */
  client_id?: string
}

/**
 * Parse GOOGLE_SERVICE_ACCOUNT_KEY, or null when it is unset or unusable.
 *
 * Defensive quote-stripping mirrors lib/vertex.ts (a common .env copy-paste
 * error). Never logs the value.
 */
export function readServiceAccountKey(
  raw: string | undefined = process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
): ServiceAccountKey | null {
  if (!raw) return null
  try {
    const key = JSON.parse(raw.replace(/^['"]|['"]$/g, '')) as Partial<ServiceAccountKey>
    if (!key.client_email || !key.private_key || !key.token_uri) return null
    return key as ServiceAccountKey
  } catch {
    return null
  }
}

/**
 * Build the signed JWT-bearer assertion for a service-account token exchange.
 *
 * `subject` is the domain-wide-delegation hook: with a `sub` claim Google
 * issues a token that acts AS that Workspace user, which is how a background
 * route reads a mailbox with no refresh token to expire. It only works once a
 * Workspace admin has authorized this key's client_id for `scope` in Admin
 * console → Security → API controls → Domain-wide delegation; until then the
 * exchange answers 401 `unauthorized_client`.
 */
export function buildServiceAccountAssertion(
  key: ServiceAccountKey,
  scope: string,
  opts: { subject?: string; nowSec?: number } = {},
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const claimSet: Record<string, string | number> = {
    iss: key.client_email,
    scope,
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  }
  if (opts.subject) claimSet.sub = opts.subject
  const payload = Buffer.from(JSON.stringify(claimSet)).toString('base64url')

  const signer = crypto.createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  const signature = signer.sign(key.private_key, 'base64url')
  return `${header}.${payload}.${signature}`
}

/**
 * Retrieve a Google access token using the GCP service account key from environment.
 *
 * @param scope Google API scope (e.g. 'https://www.googleapis.com/auth/drive.readonly')
 * @returns Access token or null if auth fails
 */
export async function getServiceAccountAccessToken(scope: string): Promise<string | null> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    console.warn('[google-auth] GOOGLE_SERVICE_ACCOUNT_KEY is not set')
    return null
  }

  try {
    const key = readServiceAccountKey()
    if (!key) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not a usable service-account JSON key')
    const jwt = buildServiceAccountAssertion(key, scope)

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
      const body = await res.text().catch((err: unknown) => { swallow(err, { module: 'google-auth', op: 'readTokenErrorBody' }); return '' })
      console.error('[google-auth] Token exchange failed:', res.status, body)
      return null
    }

    const data = await res.json() as { access_token: string }
    return data.access_token
  } catch (err) {
    console.error('[google-auth] Service account auth error:', err)
    return null
  }
}

/** Why a service-account token could not be minted — each has a different fix. */
export type ServiceAccountTokenFailure = 'unconfigured' | 'rejected' | 'network'

export class ServiceAccountTokenError extends Error {
  readonly failure: ServiceAccountTokenFailure
  readonly httpStatus?: number

  constructor(failure: ServiceAccountTokenFailure, message: string, httpStatus?: number) {
    super(message)
    this.name = 'ServiceAccountTokenError'
    this.failure = failure
    this.httpStatus = httpStatus
  }
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>()

/** Test seam: forget cached tokens. */
export function _resetServiceAccountTokenCacheForTests(): void {
  tokenCache.clear()
}

/**
 * Mint (and cache) a service-account access token, optionally impersonating a
 * Workspace user via domain-wide delegation.
 *
 * Unlike getServiceAccountAccessToken this THROWS a typed error: a background
 * sync must tell "no key mounted" from "delegation not granted" from "Google
 * unreachable", and must never read a failure as an empty result. Google's
 * OAuth error code/description is carried in the message (it names the fix,
 * e.g. `unauthorized_client` = delegation missing); the key and the token
 * never are.
 */
export async function mintServiceAccountToken(opts: {
  scope: string
  subject?: string
  signal?: AbortSignal
}): Promise<string> {
  const key = readServiceAccountKey()
  if (!key) {
    throw new ServiceAccountTokenError(
      'unconfigured',
      'GOOGLE_SERVICE_ACCOUNT_KEY is unset or not a usable service-account JSON key',
    )
  }

  const cacheKey = `${key.client_email}|${opts.scope}|${opts.subject ?? ''}`
  const cached = tokenCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token

  let assertion: string
  try {
    assertion = buildServiceAccountAssertion(key, opts.scope, { subject: opts.subject })
  } catch (err) {
    throw new ServiceAccountTokenError(
      'unconfigured',
      `service-account private_key could not sign: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  let res: Response
  try {
    res = await fetch(key.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: opts.signal,
    })
  } catch (err) {
    throw new ServiceAccountTokenError(
      'network',
      `token exchange did not complete: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!res.ok) {
    const body = await res.text().catch((err: unknown) => {
      swallow(err, { module: 'google-auth', op: 'readMintErrorBody' })
      return ''
    })
    throw new ServiceAccountTokenError(
      'rejected',
      `token exchange rejected (HTTP ${res.status}): ${describeOAuthError(body)}`,
      res.status,
    )
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) {
    throw new ServiceAccountTokenError('rejected', 'token exchange returned no access_token', res.status)
  }
  tokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  })
  return data.access_token
}

/** `{"error":"unauthorized_client","error_description":"…"}` → one bounded line. */
function describeOAuthError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string; error_description?: string }
    if (parsed.error) {
      return `${parsed.error}${parsed.error_description ? `: ${parsed.error_description.slice(0, 240)}` : ''}`
    }
  } catch {
    // not JSON — fall through
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 240) || '(empty error body)'
}
