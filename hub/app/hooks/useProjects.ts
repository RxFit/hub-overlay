import { useQuery } from '@tanstack/react-query'
import type { Project } from '@/types'

async function fetcher(url: string): Promise<{ projects: Project[] }> {
  const res = await fetch(url)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `API error ${res.status}`)
  }
  return res.json()
}

/**
 * Fetches Paperclip projects across all accessible companies.
 * Scoping is enforced server-side at /api/projects based on role:
 *   - superadmin / admin → projects from all companies
 *   - staff              → only from assigned companies
 *   - onboarding         → []
 *
 * Each project is enriched with `companyName` for grouped display.
 * Refreshes every 60 seconds.
 */
export function useProjects() {
  const { data, error, isLoading, refetch } = useQuery<{ projects: Project[] }>({
    queryKey: ['projects'],
    queryFn: () => fetcher('/api/projects'),
    // Re-fetch every 60s. Focus refetch and the 30s dedupe (staleTime) come
    // from the QueryProvider defaults.
    refetchInterval: 60_000,
  })

  return {
    projects: data?.projects ?? [],
    isLoading,
    error: error ?? undefined,
    refetch,
  }
}
