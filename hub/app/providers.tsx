'use client'

import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Client-side TanStack Query boundary (NS-6).
 *
 * The QueryClient is created lazily in component state — NOT at module scope —
 * so each browser tab/render gets its own client and there is no shared mutable
 * cache leaking across requests (which would also produce SSR hydration
 * mismatches). Defaults mirror the app's existing SWR-style contract: a short
 * staleTime for dedup and refetch-on-focus so a tab that regains focus pulls
 * fresh data (the #28 resume behavior, now provided by the library).
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: true,
          },
        },
      }),
  )

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
