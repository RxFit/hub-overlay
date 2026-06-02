/**
 * KPI Source Orchestrator
 *
 * Runs all enabled source fetchers in parallel and returns a unified
 * list of KPI updates ready to upsert into the `kpis` table.
 */
import { fetchGA4KPIs, type GA4KPI } from './ga4'
import { fetchStripeKPIs, type StripeKPI } from './stripe'
import { fetchGSCKPIs, type GSCKPIs } from './searchConsole'

export interface SyncedKPI {
  id: string            // stable identifier used as upsert key
  label: string
  value: string
  unit?: string
  trend: string
  trendDirection: 'up' | 'down' | 'neutral'
  source: 'ga4' | 'stripe' | 'gsc'
  rawValue: number
}

export interface SyncResult {
  kpis: SyncedKPI[]
  sources: {
    ga4: { ok: boolean; count: number; error?: string }
    stripe: { ok: boolean; count: number; error?: string }
    gsc: { ok: boolean; count: number; error?: string }
  }
}

export async function runAllSources(accessToken?: string): Promise<SyncResult> {
  const [ga4Result, stripeResult, gscResult] = await Promise.allSettled([
    accessToken ? fetchGA4KPIs(accessToken) : Promise.resolve([]),
    fetchStripeKPIs(),
    accessToken ? fetchGSCKPIs(accessToken) : Promise.resolve([]),
  ])

  const kpis: SyncedKPI[] = []
  const result: SyncResult = {
    kpis,
    sources: {
      ga4: { ok: false, count: 0 },
      stripe: { ok: false, count: 0 },
      gsc: { ok: false, count: 0 },
    },
  }

  if (ga4Result.status === 'fulfilled') {
    const items = ga4Result.value.map((k: GA4KPI) => ({
      ...k,
      trend: (k as GA4KPI & { trend?: string }).trend ?? '—',
      source: 'ga4' as const,
    }))
    kpis.push(...items)
    result.sources.ga4 = { ok: true, count: items.length }
  } else {
    result.sources.ga4 = { ok: false, count: 0, error: String(ga4Result.reason) }
    console.error('[kpi-sync] GA4 failed:', ga4Result.reason)
  }

  if (stripeResult.status === 'fulfilled') {
    const items = stripeResult.value.map((k: StripeKPI) => ({ ...k, source: 'stripe' as const }))
    kpis.push(...items)
    result.sources.stripe = { ok: true, count: items.length }
  } else {
    result.sources.stripe = { ok: false, count: 0, error: String(stripeResult.reason) }
    console.error('[kpi-sync] Stripe failed:', stripeResult.reason)
  }

  if (gscResult.status === 'fulfilled') {
    const items = gscResult.value.map((k: GSCKPIs) => ({ ...k, source: 'gsc' as const }))
    kpis.push(...items)
    result.sources.gsc = { ok: true, count: items.length }
  } else {
    result.sources.gsc = { ok: false, count: 0, error: String(gscResult.reason) }
    console.error('[kpi-sync] GSC failed:', gscResult.reason)
  }

  return result
}
