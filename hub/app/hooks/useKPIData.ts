'use client'

import { useQuery } from '@tanstack/react-query'
import { signIn } from 'next-auth/react'
import type { LiveKPI, ProjectKPI } from '@/types'
import { swallow } from '@/lib/swallow'
import { observePartialResponse } from '@/lib/partial-response-client'

/**
 * KPI read fetcher (NS-6). Migrated off SWR onto TanStack Query while
 * PRESERVING the 401 → reauth contract from `useWriteFetch.writeFetch`: a 401
 * (default, or explicit `{ reauth: true }`) triggers `signIn('google')` before
 * throwing a status-tagged error; `{ reauth: false }` throws without reauth.
 * Non-401 failures throw a status-tagged error (unchanged), so section-level
 * error handling keeps working. Exported for direct unit coverage.
 */
export async function fetcher(url: string) {
  const res = await fetch(url)
  observePartialResponse(res)
  if (res.status === 401) {
    const body = await res.json().catch((err: unknown) => { swallow(err, { module: 'useKPIData', op: 'parse401Body' }); return ({}) })
    // Honor the explicit reauth contract; default to reauth on any 401.
    if (body?.reauth !== false) signIn('google')
    const err = new Error(body?.error || 'Session expired — please sign in again')
    ;(err as any).status = 401
    throw err
  }
  if (!res.ok) {
    const errorData = await res.json().catch((err: unknown) => { swallow(err, { module: 'useKPIData', op: 'parseErrorBody' }); return ({}) })
    const err = new Error(errorData.error || `API error ${res.status}`)
    ;(err as any).status = res.status
    throw err
  }
  return res.json()
}

interface KPIDataResponse {
  kpis: LiveKPI[]
  projects: ProjectKPI[]
  degraded?: boolean
  error?: string
}

/**
 * Fetch aggregated KPI data and Project Health scores from the Hub backend.
 * Uses Paperclip as the primary source of truth for operational metrics.
 *
 * Read path runs on TanStack Query (NS-6): `refetchInterval` gated on `isOpen`
 * (0 → paused when the section is collapsed), `refetchOnWindowFocus: false`, and
 * a 30s `staleTime` mirror the previous SWR polling/dedup config.
 */
export function useKPIData(companyId?: string | null, isOpen: boolean = true) {
  const key = companyId && companyId !== 'all'
    ? `/api/kpis?companyId=${encodeURIComponent(companyId)}`
    : '/api/kpis'

  const { data, error, isLoading, refetch } = useQuery<KPIDataResponse>({
    queryKey: ['kpis', companyId ?? 'all'],
    queryFn: () => fetcher(key),
    refetchInterval: isOpen ? 60_000 : false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })

  return {
    kpis: data?.kpis ?? [],
    projects: data?.projects ?? [],
    degraded: data?.degraded === true,
    isLoading,
    error: (error as Error | undefined) || data?.error,
    refetch,
  }
}
