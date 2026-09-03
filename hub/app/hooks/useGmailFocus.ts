'use client'

import { useQuery } from '@tanstack/react-query'
import type { FocusItem } from '@/lib/gmail-focus'
import { emptyOn } from '@/lib/swallow'

/**
 * useGmailFocus — client read of the AI-ranked Focus queue
 * (GET /api/google/gmail/focus).
 *
 * Advisory data: every failure mode (network, 401, model outage) resolves to
 * an empty item list so the strip silently disappears instead of ever showing
 * an error state — the inbox itself is the primary surface and has its own
 * error handling. The server caches rankings per inbox signature, so the
 * 5-minute client poll is cheap (cache hits don't call the model).
 *
 * `background: true` keeps the poll alive while the tab is hidden — used by
 * the urgent-alert watcher (useFocusNotifications), which is pointless if it
 * only checks while the user is already looking at the app.
 */

/** FocusItem + display fields the server joins from LIVE Gmail thread data
 *  (never from model output) — used for notification copy. */
export type FocusDisplayItem = FocusItem & { from?: string; subject?: string }

export function useGmailFocus(enabled: boolean = true, opts: { background?: boolean } = {}) {
  const { data, isLoading } = useQuery({
    queryKey: ['gmail', 'focus'],
    enabled,
    queryFn: async (): Promise<{ items: FocusDisplayItem[]; degraded: boolean }> => {
      const r = await fetch('/api/google/gmail/focus')
      if (!r.ok) return { items: [], degraded: true }
      const d = await r.json().catch((err: unknown) => emptyOn(err, { module: 'useGmailFocus', op: 'parseFocusBody' }, null))
      return {
        items: Array.isArray(d?.items) ? (d.items as FocusDisplayItem[]) : [],
        // The server sets this when the AI ranking stage failed and the items
        // are deterministic-only. The strip says so rather than presenting an
        // outage as working AI ranking.
        degraded: d?.degraded === true,
      }
    },
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: opts.background ?? false,
    refetchOnWindowFocus: false,
    staleTime: 4 * 60_000,
    retry: 1,
  })

  return {
    focusItems: data?.items ?? [],
    focusLoading: isLoading,
    focusDegraded: data?.degraded ?? false,
  }
}
