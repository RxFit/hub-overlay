'use client'

import { SessionProvider } from 'next-auth/react'

/**
 * Client-side providers wrapper.
 * SessionProvider enables useSession() in any client component.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>{children}</SessionProvider>
  )
}
