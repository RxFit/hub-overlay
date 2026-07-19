'use client'
import { signIn } from 'next-auth/react'

/**
 * Fetch wrapper for write mutations (POST/DELETE/PUT).
 * - On 401 { reauth: true } (or any 401), triggers Google re-auth and throws.
 * - On any other !res.ok, throws an Error carrying `.status`.
 * - On success, returns the parsed JSON (or {} if no body).
 * Routes that fail Google auth return 401 { reauth: true } via
 * lib/google-session.ts → googleApiErrorResponse / resolveGoogleAuth.
 */
export async function writeFetch<T = any>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init)
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}))
    // Honor the explicit reauth contract; default to reauth on any 401.
    if (body?.reauth !== false) signIn('google')
    const err = new Error(body?.error || 'Session expired — please sign in again')
    ;(err as any).status = 401
    throw err
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err = new Error(body?.error || `Request failed (${res.status})`)
    ;(err as any).status = res.status
    throw err
  }
  return res.json().catch(() => ({} as T))
}
