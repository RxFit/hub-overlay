import { useQuery } from '@tanstack/react-query'
import type { Company } from '@/types'

async function fetcher(url: string): Promise<{ companies: Company[] }> {
  const res = await fetch(url)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
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
