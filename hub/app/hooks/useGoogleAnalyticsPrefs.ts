'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { refreshSessionCookie } from '@/app/hooks/useHubData'
import type { GooglePrefsValues } from '@/lib/google/prefs'

/**
 * Hooks for the tenant's analytics configuration — which GA4 property and
 * Search Console site the Hub reads from.
 *
 * The pickers are fetched LAZILY (`enabled`), not on mount. Enumerating GA4
 * accounts and GSC sites is two extra Google round trips that most visits to
 * the settings page don't need: the common case is opening Settings for
 * something else entirely. They load when the admin actually opens the section.
 */

/* ── Shared fetcher (same error contract as useGoogleChat/useHubData) ── */

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (res.status === 401) {
    const body = await res.json().catch(() => ({} as Record<string, unknown>))
    // A merely-stale access token is repairable — rotate the cookie so the
    // retry succeeds instead of bouncing the user to sign-in.
    if (body?.refresh === true) await refreshSessionCookie()
    const err = new Error(typeof body?.error === 'string' ? body.error : 'Unauthorized')
    ;(err as any).status = 401
    ;(err as any).reauth = body?.reauth
    throw err
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Unknown error' }))
    const err = new Error(body?.error ?? `API error ${res.status}`)
    ;(err as any).status = res.status
    ;(err as any).code = body?.code
    // API_NOT_ENABLED responses carry Google's console activation link so the
    // operator gets a one-click path to the fix.
    ;(err as any).activationUrl = body?.activationUrl
    throw err
  }
  return res.json()
}

export interface GA4PropertyOption {
  propertyId: string
  displayName: string
  accountName: string
}

export interface GSCSiteOption {
  siteUrl: string
  permissionLevel: string
}

export const googlePrefsQueryKey = ['google-prefs'] as const
const ga4PropertiesQueryKey = ['google-prefs', 'ga4-properties'] as const
const gscSitesQueryKey = ['google-prefs', 'gsc-sites'] as const

/**
 * The tenant's effective analytics configuration (stored values, else the
 * legacy env-var fallback — so this shows what the app is actually using, not
 * an empty form on a deployment that has always run on env vars).
 */
export function useGooglePrefs() {
  const { data, isLoading, error } = useQuery({
    queryKey: googlePrefsQueryKey,
    queryFn: () => fetcher<{ prefs: GooglePrefsValues }>('/api/settings/google-prefs'),
    staleTime: 60_000,
    retry: false,
  })

  return {
    prefs: data?.prefs ?? {},
    isLoading,
    error: error as Error | null,
    // 403 here means "not an admin" — a normal state for staff, not a failure
    // worth showing as an error.
    forbidden: (error as any)?.status === 403,
  }
}

/** GA4 properties the signed-in admin can read. Fetched only when `enabled`. */
export function useGA4Properties(enabled: boolean) {
  const { data, isLoading, error } = useQuery({
    queryKey: ga4PropertiesQueryKey,
    queryFn: () => fetcher<{ properties: GA4PropertyOption[] }>('/api/google/analytics/properties'),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })

  return {
    properties: data?.properties ?? [],
    isLoading,
    error: error as Error | null,
    missingScope: (error as any)?.code === 'MISSING_SCOPE',
    // A Google API disabled in the Cloud project — an operator problem that
    // re-consent cannot fix, so the UI must NOT respond with a sign-in prompt.
    apiNotEnabled: (error as any)?.code === 'API_NOT_ENABLED',
    activationUrl: (error as any)?.activationUrl as string | undefined,
  }
}

/** Verified Search Console sites. Fetched only when `enabled`. */
export function useGSCSites(enabled: boolean) {
  const { data, isLoading, error } = useQuery({
    queryKey: gscSitesQueryKey,
    queryFn: () => fetcher<{ sites: GSCSiteOption[] }>('/api/google/search-console/sites'),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })

  return {
    sites: data?.sites ?? [],
    isLoading,
    error: error as Error | null,
    missingScope: (error as any)?.code === 'MISSING_SCOPE',
    apiNotEnabled: (error as any)?.code === 'API_NOT_ENABLED',
    activationUrl: (error as any)?.activationUrl as string | undefined,
  }
}

/**
 * Persist the analytics configuration.
 *
 * Returns false rather than throwing so the component can show an inline
 * error; the server's normalized values are written straight into the cache so
 * the form reflects what was actually stored (a pasted "properties/123" comes
 * back as "123").
 */
export function useSaveGooglePrefs() {
  const queryClient = useQueryClient()
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const save = useCallback(
    async (values: GooglePrefsValues): Promise<boolean> => {
      setIsSaving(true)
      setSaveError(null)
      try {
        const res = await fetch('/api/settings/google-prefs', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error ?? `Save failed (${res.status})`)
        }
        const { prefs } = (await res.json()) as { prefs: GooglePrefsValues }
        queryClient.setQueryData<{ prefs: GooglePrefsValues }>(googlePrefsQueryKey, { prefs })
        return true
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save')
        return false
      } finally {
        setIsSaving(false)
      }
    },
    [queryClient],
  )

  return { save, isSaving, saveError, clearError: () => setSaveError(null) }
}
