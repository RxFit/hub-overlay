import { useQuery } from '@tanstack/react-query'
import type { Company } from '@/types'
import { swallow } from '@/lib/swallow'

async function fetcher(url: string): Promise<{ companies: Company[] }> {
  const res = await fetch(url)
  if (!res.ok) {
    // A non-JSON error body is expected from proxies/edge 5xx pages; fall back
    // to an empty object so the status-based message below still fires.
    const data = await res.json().catch((err: unknown) => {
      swallow(err, { module: 'useCompanies', op: 'parseErrorBody' })
      return {}
    })
    throw new Error(data.error || `API error ${res.status}`)
  }
  return res.json()
}

/**
 * Fetches the list of Paperclip companies the current user can access.
 * Scoping is enforced server-side at /api/companies based on role:
 *   - superadmin / admin → all companies
 *   - staff              → only assigned companies
 *   - onboarding         → []
 *
 * Falls back to an empty array on error — callers should handle gracefully.
 */
export function useCompanies() {
  const { data, error, isLoading, refetch } = useQuery<{ companies: Company[] }>({
    queryKey: ['companies'],
    queryFn: () => fetcher('/api/companies'),
    // Re-fetch every 60s to pick up new Paperclip workspaces. Focus refetch and
    // the 30s dedupe (staleTime) come from the QueryProvider defaults.
    refetchInterval: 60_000,
  })

  return {
    companies: data?.companies ?? [],
    isLoading,
    error: error ?? undefined,
    refetch,
  }
}
