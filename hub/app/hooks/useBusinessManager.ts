'use client'

import { useQuery } from '@tanstack/react-query'
import { swallow } from '@/lib/swallow'
import type { CEOPulseRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════════════════════
   useBusinessManager
   Fetches the CEO Pulse record and computes derived Business Manager state.
   Polls every 5 minutes — same cadence as stall detector.
   ══════════════════════════════════════════════════════════════════════════════ */

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text().catch((err: unknown) => { swallow(err, { module: 'useBusinessManager', op: 'readErrorBody' }); return 'Unknown error' })
    const err = new Error(`API error ${res.status}: ${body}`)
    ;(err as any).status = res.status
    throw err
  }
  return res.json()
}

interface BusinessManagerState {
  pulse: CEOPulseRecord | null
  globalHealthPct: number
  orgName: string
  isLoading: boolean
  error: Error | undefined
  mutate: () => void
}

export function useBusinessManager(orgId?: string): BusinessManagerState {
  const url = orgId
    ? `/api/paperclip/ceo-pulse?orgId=${encodeURIComponent(orgId)}`
    : '/api/paperclip/ceo-pulse'

  const { data, error, isLoading, refetch } = useQuery<CEOPulseRecord>({
    queryKey: ['ceo-pulse', orgId ?? 'default'],
    queryFn: () => fetcher<CEOPulseRecord>(url),
    // Poll every 5 minutes — matches stall detector cadence
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    // Retry failures up to 3 times; stale data keeps rendering meanwhile
    retry: 3,
  })

  return {
    pulse: data ?? null,
    globalHealthPct: data?.globalHealthPct ?? 0,
    orgName: data?.org ?? '',
    isLoading,
    error: error ?? undefined,
    mutate: refetch,
  }
}

/** Helper: maps DepartmentHealth to a CSS-friendly color token name */
export function healthToColor(status: string): 'green' | 'amber' | 'red' | 'gray' {
  switch (status) {
    case 'ON_TRACK': return 'green'
    case 'DRIFTING': return 'amber'
    case 'CRITICAL': return 'red'
    default: return 'gray'
  }
}

// roleLabel now lives in lib/agentRoles.ts (single source for role
// classification + display); re-exported here so existing consumers keep
// their import path.
export { roleLabel } from '@/lib/agentRoles'
