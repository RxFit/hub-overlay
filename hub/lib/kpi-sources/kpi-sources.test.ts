import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchGA4KPIs } from './ga4'
import { fetchStripeKPIs } from './stripe'
import { fetchGSCKPIs } from './searchConsole'
import { runAllSources } from './index'

/**
 * KPI source fetchers (GA4 / Stripe / Search Console) + the orchestrator.
 *
 * `fetch` is fully mocked with URL/body routing — no network. These tests lock
 * the REAL contracts: env-guard skips, metric parsing, number formatting,
 * trend math (including the inverted "lower is better" metrics), per-call
 * degradation, and the orchestrator's partial-failure fan-in.
 */

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

/** GA4 runReport payload: one row whose metricValues align with the request order. */
function ga4Report(values: number[]) {
  return { rows: [{ metricValues: values.map((v) => ({ value: String(v) })) }] }
}

describe('fetchGA4KPIs', () => {
  it('skips (returns []) when GA4_PROPERTY_ID is not configured', async () => {
    vi.stubEnv('GA4_PROPERTY_ID', '')
    await expect(fetchGA4KPIs('token')).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps both report periods into formatted, trended KPIs', async () => {
    vi.stubEnv('GA4_PROPERTY_ID', '123456')
    // metrics order: sessions, newUsers, totalUsers, bounceRate, avgSessionDuration, screenPageViews
    fetchMock.mockImplementation(async (url: string, init: { body: string }) => {
      expect(url).toContain('properties/123456:runReport')
      const body = JSON.parse(init.body)
      const isCurrent = body.dateRanges[0].startDate === '7daysAgo'
      return isCurrent
        ? jsonResponse(ga4Report([12500, 300, 400, 0.4, 60, 2_000_000]))
        : jsonResponse(ga4Report([10000, 300, 350, 0.5, 55, 1_000_000]))
    })

    const kpis = await fetchGA4KPIs('token')
    expect(kpis.map((k) => k.id)).toEqual([
      'ga4_sessions',
      'ga4_new_users',
      'ga4_bounce_rate',
      'ga4_pageviews',
    ])

    const sessions = kpis[0] as (typeof kpis)[0] & { trend: string }
    expect(sessions.value).toBe('12.5k') // formatNum thousands
    expect(sessions.trend).toBe('+25.0%')
    expect(sessions.trendDirection).toBe('up')

    // Flat metric (300 → 300) → previous==current → 0% → neutral.
    const newUsers = kpis[1] as (typeof kpis)[1] & { trend: string }
    expect(newUsers.trendDirection).toBe('neutral')

    // Bounce rate is LOWER-IS-BETTER: 50% → 40% must read as an UP (improving) trend.
    const bounce = kpis[2]
    expect(bounce.value).toBe('40.0%')
    expect(bounce.trendDirection).toBe('up')

    // Millions formatting.
    expect(kpis[3].value).toBe('2.0M')
  })

  it('throws on an upstream GA4 error (surfaced to the orchestrator)', async () => {
    vi.stubEnv('GA4_PROPERTY_ID', '123456')
    fetchMock.mockResolvedValue(jsonResponse({ error: 'denied' }, false, 403))
    await expect(fetchGA4KPIs('token')).rejects.toThrow('GA4 API error 403')
  })
})

describe('fetchStripeKPIs', () => {
  it('skips (returns []) when STRIPE_SECRET_KEY is not configured', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    await expect(fetchStripeKPIs()).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aggregates succeeded charges only and formats cents as dollars', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test')
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/subscriptions')) return jsonResponse({ total_count: 4 })
      if (url.includes('/customers')) {
        // 30d window vs 31–60d window, keyed off the created[lt] clause
        return url.includes('created%5Blt%5D') || url.includes('created[lt]')
          ? jsonResponse({ total_count: 5 })
          : jsonResponse({ total_count: 10 })
      }
      if (url.includes('/charges')) {
        const isLastMonth = url.includes('created%5Blt%5D') || url.includes('created[lt]')
        return isLastMonth
          ? jsonResponse({ data: [{ amount: 50_000, status: 'succeeded' }] })
          : jsonResponse({
              data: [
                { amount: 100_000, status: 'succeeded' },
                { amount: 999_999, status: 'failed' }, // must be EXCLUDED
              ],
            })
      }
      throw new Error(`unexpected stripe url ${url}`)
    })

    const kpis = await fetchStripeKPIs()
    const byId = Object.fromEntries(kpis.map((k) => [k.id, k]))

    // $1,000.00 MTD (failed charge excluded), doubled vs last month's $500.
    expect(byId.stripe_revenue_mtd.value).toBe('$1.0k')
    expect(byId.stripe_revenue_mtd.rawValue).toBe(100_000)
    expect(byId.stripe_revenue_mtd.trend).toBe('+100.0%')
    expect(byId.stripe_revenue_mtd.trendDirection).toBe('up')

    expect(byId.stripe_active_subs.value).toBe('4')
    // MRR estimate: round(100000/4)*4 = 100000 cents.
    expect(byId.stripe_mrr.rawValue).toBe(100_000)

    expect(byId.stripe_new_customers.value).toBe('10')
    expect(byId.stripe_new_customers.trend).toBe('+100.0%')
  })

  it('degrades each failing endpoint to 0 instead of failing the whole sync', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test')
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, false, 500))

    const kpis = await fetchStripeKPIs()
    const byId = Object.fromEntries(kpis.map((k) => [k.id, k]))
    expect(byId.stripe_revenue_mtd.rawValue).toBe(0)
    expect(byId.stripe_revenue_mtd.value).toBe('$0')
    expect(byId.stripe_revenue_mtd.trend).toBe('new') // no previous → 'new'
    expect(byId.stripe_active_subs.value).toBe('0')
  })
})

describe('fetchGSCKPIs', () => {
  it('skips (returns []) when GSC_SITE_URL is not configured', async () => {
    vi.stubEnv('GSC_SITE_URL', '')
    await expect(fetchGSCKPIs('token')).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('converts ctr to %, and treats a LOWER average position as an improvement', async () => {
    vi.stubEnv('GSC_SITE_URL', 'https://rxfitatx.com')
    fetchMock.mockImplementation(async (url: string, init: { body: string }) => {
      expect(url).toContain(encodeURIComponent('https://rxfitatx.com'))
      const body = JSON.parse(init.body)
      // Distinguish periods by recency of startDate: the current window starts
      // 28 days ago, the previous one 56 days ago.
      const daysBack = Math.round((Date.now() - new Date(body.startDate).getTime()) / 86_400_000)
      return daysBack <= 29
        ? jsonResponse({ rows: [{ clicks: 200, impressions: 4000, ctr: 0.05, position: 8 }] })
        : jsonResponse({ rows: [{ clicks: 100, impressions: 4000, ctr: 0.025, position: 10 }] })
    })

    const kpis = await fetchGSCKPIs('token')
    const byId = Object.fromEntries(kpis.map((k) => [k.id, k]))

    expect(byId.gsc_clicks.value).toBe('200')
    expect(byId.gsc_clicks.trend).toBe('+100.0%')
    expect(byId.gsc_clicks.trendDirection).toBe('up')

    expect(byId.gsc_ctr.value).toBe('5.00%') // 0.05 → 5%
    expect(byId.gsc_impressions.trendDirection).toBe('neutral') // 4000 → 4000

    // Position went 10 → 8 (better). Natural trend is DOWN; inverted → UP.
    expect(byId.gsc_position.value).toBe('8.0')
    expect(byId.gsc_position.trendDirection).toBe('up')
  })

  it('returns zeroed metrics when GSC has no rows for the site', async () => {
    vi.stubEnv('GSC_SITE_URL', 'https://rxfitatx.com')
    fetchMock.mockResolvedValue(jsonResponse({ rows: [] }))
    const kpis = await fetchGSCKPIs('token')
    const byId = Object.fromEntries(kpis.map((k) => [k.id, k]))
    expect(byId.gsc_clicks.rawValue).toBe(0)
    expect(byId.gsc_clicks.trend).toBe('—')
  })

  it('throws on an upstream GSC error', async () => {
    vi.stubEnv('GSC_SITE_URL', 'https://rxfitatx.com')
    fetchMock.mockResolvedValue(jsonResponse({ error: 'quota' }, false, 429))
    await expect(fetchGSCKPIs('token')).rejects.toThrow('GSC API 429')
  })
})

describe('runAllSources (orchestrator)', () => {
  it('skips the Google-token sources when no access token is provided', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '') // stripe skips via env guard
    const result = await runAllSources(undefined)

    expect(result.kpis).toEqual([])
    expect(result.sources.ga4).toEqual({ ok: true, count: 0 })
    expect(result.sources.gsc).toEqual({ ok: true, count: 0 })
    expect(result.sources.stripe).toEqual({ ok: true, count: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a failing source without losing the healthy ones', async () => {
    vi.stubEnv('GA4_PROPERTY_ID', '123456')
    vi.stubEnv('GSC_SITE_URL', '')
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test')

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('analyticsdata')) return jsonResponse({ err: 'boom' }, false, 500)
      // All stripe endpoints succeed minimally.
      return jsonResponse({ total_count: 2, data: [] })
    })

    const result = await runAllSources('google-token')

    expect(result.sources.ga4.ok).toBe(false)
    expect(result.sources.ga4.error).toContain('GA4 API error 500')

    expect(result.sources.stripe).toEqual({ ok: true, count: 4 })
    expect(result.sources.gsc).toEqual({ ok: true, count: 0 })

    // Only stripe KPIs made it through, tagged with their source.
    expect(result.kpis).toHaveLength(4)
    expect(result.kpis.every((k) => k.source === 'stripe')).toBe(true)
  })
})
