import useSWR from 'swr'
import type { LiveKPI, ProjectKPI } from '@/types'

export async function fetcher(url: string) {
  const res = await fetch(url)
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}))
    const err = new Error(errorData.error || `API error ${res.status}`)
    ;(err as any).status = res.status
    throw err
  }
  return res.json()
}

interface KPIDataResponse {
  kpis: LiveKPI[]
  projects: ProjectKPI[]
  error?: string
}

/**
 * Fetch aggregated KPI data and Project Health scores from the Hub backend.
 * Uses Paperclip as the primary source of truth for operational metrics.
 */
export function useKPIData(companyId?: string | null) {
  const key = companyId && companyId !== 'all'
    ? `/api/kpis?companyId=${encodeURIComponent(companyId)}`
    : '/api/kpis'
  
  const { data, error, isLoading, mutate } = useSWR<KPIDataResponse>(
    key,
    fetcher,
    { refreshInterval: 60_000, revalidateOnFocus: true }
  )

  return {
    kpis: data?.kpis ?? [],
    projects: data?.projects ?? [],
    isLoading,
    error: error || data?.error,
    refetch: mutate,
  }
}
