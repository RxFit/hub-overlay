'use client'

import { useQuery } from '@tanstack/react-query'
import type { FocusItem } from '@/lib/gmail-focus'

/**
 * useGmailFocus — client read of the AI-ranked Focus queue
 * (GET /api/google/gmail/focus).
 *
 * Advisory data: every failure mode (network, 401, model outage) resolves to
 * an empty item list so the strip silently disappears instead of ever showing
 * an error state — the inbox itself is the primary surface and has its own
 * error handling. The server caches rankings per inbox signature, so the
 * 5-minute client poll is cheap (cache hits don't call the model).
 */
export function useGmailFocus(enabled: boolean = true) {
  const { data, isLoading } = useQuery({
    queryKey: ['gmail', 'focus'],
    enabled,
    queryFn: async (): Promise<{ items: FocusItem[] }> => {
      const r = await fetch('/api/google/gmail/focus')
      if (!r.ok) return { items: [] }
      const d = await r.json().catch(() => null)
      return { items: Array.isArray(d?.items) ? (d.items as FocusItem[]) : [] }
    },
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: false,
    staleTime: 4 * 60_000,
    retry: 1,
  })

  return {
    focusItems: data?.items ?? [],
    focusLoading: isLoading,
  }
}
