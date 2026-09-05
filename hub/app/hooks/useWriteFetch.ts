'use client'
import { signIn } from 'next-auth/react'
import { swallow } from '@/lib/swallow'
import { observePartialResponse } from '@/lib/partial-response-client'

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
  observePartialResponse(res)
  if (res.status === 401) {
    // Non-JSON or empty 401 body: fall through to the default reauth message.
    const body = await res.json().catch((err: unknown) => { swallow(err, { module: 'useWriteFetch', op: 'parse401Body' }); return ({}) })
    // Honor the explicit reauth contract; default to reauth on any 401.
    if (body?.reauth !== false) signIn('google')
    const err = new Error(body?.error || 'Session expired — please sign in again')
    ;(err as any).status = 401
    throw err
  }
  if (!res.ok) {
    // Non-JSON or empty error body: fall through to the generic status message.
    const body = await res.json().catch((err: unknown) => { swallow(err, { module: 'useWriteFetch', op: 'parseErrorBody' }); return ({}) })
    const err = new Error(body?.error || `Request failed (${res.status})`)
    ;(err as any).status = res.status
    throw err
  }
  // Empty/non-JSON success body (e.g. 204): resolve to an empty object per the contract above.
  return res.json().catch((err: unknown) => { swallow(err, { module: 'useWriteFetch', op: 'parseSuccessBody' }); return ({} as T) })
}
