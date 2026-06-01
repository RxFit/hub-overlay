/**
 * Paperclip Session Auth
 * 
 * Authenticates to Paperclip Cloud Run via email/password sign-in
 * and caches the session cookie for subsequent API calls.
 * 
 * This replaces the API key auth (sk_pc_*) which requires manual
 * key generation in the Paperclip web UI. Session auth uses the
 * same credentials as the sync-railway-to-cloudrun.ps1 script.
 */

const PAPERCLIP_BASE = process.env.PAPERCLIP_BASE_URL || 'https://rxfit-paperclip-11747747730.us-central1.run.app'
const PAPERCLIP_EMAIL = process.env.PAPERCLIP_AUTH_EMAIL || 'Danny@rxfitatx.com'
const PAPERCLIP_PASSWORD = process.env.PAPERCLIP_AUTH_PASSWORD || 'Paperclip2026!'

// Session cookie cache
let cachedCookie: string | null = null
let cookieExpiresAt = 0

/**
 * Sign in to Paperclip and return the session cookie string.
 * Caches the cookie for 55 minutes (Paperclip sessions typically last 1 hour).
 */
async function signIn(): Promise<string> {
  const now = Date.now()
  if (cachedCookie && now < cookieExpiresAt) {
    return cachedCookie
  }

  const res = await fetch(`${PAPERCLIP_BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': PAPERCLIP_BASE,  // Required: Paperclip rejects sign-in without Origin header
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
  const sessionCookie = setCookieHeaders
    .map(h => h.split(';')[0]) // take just the name=value part
    .filter(c => c.includes('session_token'))
    .join('; ')

  if (!sessionCookie) {
    // Fallback: try to find any __Secure-paperclip or similar cookie
    const allCookies = setCookieHeaders.map(h => h.split(';')[0]).join('; ')
    if (allCookies) {
      cachedCookie = allCookies
      cookieExpiresAt = now + 6 * 24 * 60 * 60 * 1000 // 6 days (Paperclip cookie Max-Age is 7 days)
      return cachedCookie
    }
    throw new Error('Paperclip sign-in succeeded but no session cookie returned')
  }

  cachedCookie = sessionCookie
  cookieExpiresAt = now + 6 * 24 * 60 * 60 * 1000 // 6 days (Paperclip cookie Max-Age is 7 days)
  return cachedCookie
}

/**
 * Get auth headers for Paperclip API calls.
 * Uses session cookie auth (primary) with API key as fallback.
 */
export async function getPaperclipAuthHeaders(): Promise<Record<string, string>> {
  const PAPERCLIP_KEY = process.env.PAPERCLIP_API_KEY || ''

  try {
    const cookie = await signIn()
    return { Cookie: cookie }
  } catch (err) {
    console.warn('[paperclipSession] Session auth failed, falling back to API key:', err)
    // Fallback to API key if session auth fails
    if (PAPERCLIP_KEY) {
      return { Authorization: `Bearer ${PAPERCLIP_KEY}` }
    }
    throw new Error('No Paperclip auth available: session auth failed and no API key configured')
  }
}

/**
 * Clear the cached session (e.g., after a 401 response).
 */
export function clearPaperclipSession(): void {
  cachedCookie = null
  cookieExpiresAt = 0
}
