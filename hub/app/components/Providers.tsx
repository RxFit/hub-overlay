'use client'

import { SessionProvider } from 'next-auth/react'

/**
 * Client-side providers wrapper.
 * SessionProvider enables useSession() in any client component.
 *
 * WHY THE REFETCH SETTINGS MATTER (this is a bug fix, not tuning)
 * --------------------------------------------------------------
 * The Google access token is refreshed inside NextAuth's `jwt` callback — but
 * that callback only PERSISTS its result on a request that can write a
 * Set-Cookie header. In the App Router, `getServerSession()` (used by every
 * route handler here) builds its response object with a no-op `setCookie()`
 * — see node_modules/next-auth/next/index.js — so the refreshed token it
 * computes is silently discarded.
 *
 * The one code path that does persist the rotated cookie is `/api/auth/session`,
 * which is exactly what this provider polls. With no `refetchInterval`, a tab
 * left open never called it, so roughly an hour after sign-in the cookie still
 * held an EXPIRED access token; every Google route then handed that dead token
 * to Google, got a 401 back, and the client escalated it into a full re-login.
 * That is the "constant forced relogins, even without code changes" symptom —
 * time-driven and roughly hourly, which is why it tracked no deploy.
 *
 * Polling every 10 minutes keeps the cookie's access token well inside its
 * ~60-minute life. It is one cheap same-origin request against the failure it
 * prevents.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider refetchInterval={10 * 60} refetchOnWindowFocus>
      {children}
    </SessionProvider>
  )
}
