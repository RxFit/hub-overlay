/**
 * Paperclip Session Auth
 *
 * Authenticates to Paperclip Cloud Run via email/password sign-in
 * and caches the session cookie for subsequent API calls.
 *
 * HARDENING:
 *  - Mutex prevents thundering-herd sign-in storms (F1)
 *  - No hardcoded credential fallbacks (F3)
 *  - API key kept as fallback if session auth fails entirely
 *  - Circuit breaker prevents hammering a down auth endpoint
 *  - Retry with backoff on transient sign-in failures
 */

import { createLogger } from '@/lib/logger'
import { breaker } from '@/lib/circuit-breaker'
import { withRetry } from '@/lib/retry'
import { getTenantId } from './tenant-context'

const log = createLogger('paperclipSession')

const PAPERCLIP_BASE = process.env.PAPERCLIP_BASE_URL ?? ''
const PAPERCLIP_EMAIL = process.env.PAPERCLIP_AUTH_EMAIL ?? ''
const PAPERCLIP_PASSWORD = process.env.PAPERCLIP_AUTH_PASSWORD ?? ''

if (!PAPERCLIP_BASE) {
  log.error('PAPERCLIP_BASE_URL is not set')
}

// Session cookie cache
let cachedCookie: string | null = null
let cookieExpiresAt = 0

// Mutex: in-flight sign-in promise deduplication (prevents thundering herd)
let signInPromise: Promise<string> | null = null

/**
 * Sign in to Paperclip and return the session cookie string.
 * Uses a mutex to prevent concurrent sign-in requests.
 * Caches the cookie for 6 days (Paperclip cookie Max-Age is 7 days).
 */
async function signIn(): Promise<string> {
  const now = Date.now()

  // Return cached cookie if still valid
  if (cachedCookie && now < cookieExpiresAt) {
    return cachedCookie
  }

  // Mutex: if a sign-in is already in flight, wait for it
  if (signInPromise) {
    return signInPromise
  }

  // Start the sign-in and store the promise so concurrent callers share it
  const tenantId = getTenantId()
  signInPromise = breaker.execute(`${tenantId}:paperclip-auth`, () =>
    withRetry(() => doSignIn(), { maxAttempts: 2, baseMs: 1000 }),
  )

  try {
    const result = await signInPromise
    return result
  } finally {
    signInPromise = null
  }
}

/**
 * Actual sign-in implementation (called only once per expiry cycle).
 */
async function doSignIn(): Promise<string> {
  if (!PAPERCLIP_EMAIL || !PAPERCLIP_PASSWORD) {
    throw new Error(
      'Paperclip session auth requires PAPERCLIP_AUTH_EMAIL and PAPERCLIP_AUTH_PASSWORD env vars'
    )
  }

  const res = await fetch(`${PAPERCLIP_BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: PAPERCLIP_BASE,
    },
    body: JSON.stringify({ email: PAPERCLIP_EMAIL.toLowerCase(), password: PAPERCLIP_PASSWORD }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Paperclip sign-in failed (${res.status}): ${body}`)
  }

  // Extract session cookie from Set-Cookie header
  const setCookieHeaders = res.headers.getSetCookie?.() ?? []

  // Fallback for environments where getSetCookie isn't available
  if (setCookieHeaders.length === 0) {
    const raw = res.headers.get('set-cookie')
    if (raw) {
      setCookieHeaders.push(...raw.split(/,(?=\s*\w+=)/))
    }
  }

  const sessionCookie = setCookieHeaders
    .map((h) => h.split(';')[0].trim())
    .filter((c) => c.includes('session_token'))
    .join('; ')

  if (!sessionCookie) {
    const allCookies = setCookieHeaders.map((h) => h.split(';')[0].trim()).join('; ')
    if (allCookies) {
      cachedCookie = allCookies
      cookieExpiresAt = Date.now() + 6 * 24 * 60 * 60 * 1000 // 6 days
      log.info('Session established (fallback cookies)')
      return cachedCookie
    }
    throw new Error('Paperclip sign-in succeeded but no session cookie returned')
  }

  cachedCookie = sessionCookie
  cookieExpiresAt = Date.now() + 6 * 24 * 60 * 60 * 1000 // 6 days
  log.info('Session established')
  return cachedCookie
}

/**
 * Get auth headers for Paperclip API calls.
 * Uses session cookie auth (primary) with API key as fallback.
 */
export async function getPaperclipAuthHeaders(): Promise<Record<string, string>> {
  const PAPERCLIP_KEY = process.env.PAPERCLIP_API_KEY || ''

  if (PAPERCLIP_EMAIL && PAPERCLIP_PASSWORD) {
    try {
      const cookie = await signIn()
      return { Cookie: cookie }
    } catch (err) {
      log.warn({ err }, 'Session auth failed, falling back to API key')
    }
  }

  if (PAPERCLIP_KEY) {
    return { Authorization: `Bearer ${PAPERCLIP_KEY}` }
  }

  throw new Error(
    'No Paperclip auth available: set PAPERCLIP_AUTH_EMAIL + PAPERCLIP_AUTH_PASSWORD, or PAPERCLIP_API_KEY'
  )
}

/**
 * Clear the cached session (e.g., after a 401 response).
 */
export function clearPaperclipSession(): void {
  cachedCookie = null
  cookieExpiresAt = 0
  log.info('Session cleared')
}
