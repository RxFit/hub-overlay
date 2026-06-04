'use client'

import useSWR from 'swr'
import type { CEOPulseRecord } from '@/types'

/* ══════════════════════════════════════════════════════════════════════════════
   useBusinessManager
   Fetches the CEO Pulse record and computes derived Business Manager state.
   Polls every 5 minutes — same cadence as stall detector.
   ══════════════════════════════════════════════════════════════════════════════ */

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text().catch(() => 'Unknown error')
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

const ROLE_DISPLAY: Record<string, string> = {
  ceo: 'CEO',
  cmo: 'CMO',
  cto: 'CTO',
  cfo: 'CFO',
  coo: 'COO',
  marketing: 'Marketing',
  technical: 'Technical',
  revenue: 'Revenue',
}

export function useBusinessManager(orgId?: string): BusinessManagerState {
  const url = orgId
    ? `/api/paperclip/ceo-pulse?orgId=${encodeURIComponent(orgId)}`
    : '/api/paperclip/ceo-pulse'

  const { data, error, isLoading, mutate } = useSWR<CEOPulseRecord>(
    url,
    fetcher,
    {
      // Poll every 5 minutes — matches stall detector cadence
      refreshInterval: 5 * 60 * 1000,
      revalidateOnFocus: false,
      // Don't throw on error, return stale data
      shouldRetryOnError: true,
      errorRetryCount: 3,
    }
  )

  return {
    pulse: data ?? null,
    globalHealthPct: data?.globalHealthPct ?? 0,
    orgName: data?.org ?? '',
    isLoading,
    error,
    mutate,
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

/** Helper: human-readable label for a role key */
export function roleLabel(role: string): string {
  return ROLE_DISPLAY[role] ?? role.toUpperCase()
}
