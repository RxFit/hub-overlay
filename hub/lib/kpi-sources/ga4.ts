/**
 * GA4 Data API v1beta — fetches key web metrics for the last 7 days.
 * Uses the authenticated user's Google OAuth access token.
 *
 * Requires: GA4_PROPERTY_ID env var + analytics.readonly OAuth scope.
 */

export interface GA4Metrics {
  sessions: number
  newUsers: number
  totalUsers: number
  bounceRate: number          // 0–100
  avgSessionDurationSec: number
  pageViews: number
}

export interface GA4KPI {
  id: string                  // e.g. 'ga4_sessions'
  label: string
  value: string
  unit?: string
  trendDirection: 'up' | 'down' | 'neutral'
  rawValue: number
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function computeTrend(current: number, previous: number): { trend: string; direction: 'up' | 'down' | 'neutral' } {
  if (!previous || previous === 0) return { trend: '—', direction: 'neutral' }
  const pct = ((current - previous) / previous) * 100
  const sign = pct >= 0 ? '+' : ''
  return {
    trend: `${sign}${pct.toFixed(1)}%`,
    direction: pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'neutral',
  }
}

async function runGA4Report(
  accessToken: string,
  propertyId: string,
  startDate: string,
  endDate: string,
  metrics: string[]
): Promise<Record<string, number>> {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`
  const body = {
    dateRanges: [{ startDate, endDate }],
    metrics: metrics.map(name => ({ name })),
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`GA4 API error ${res.status}: ${err.slice(0, 200)}`)
  }

  const data = await res.json()
  const row = data.rows?.[0]?.metricValues ?? []
  const result: Record<string, number> = {}
  metrics.forEach((name, i) => {
    result[name] = parseFloat(row[i]?.value ?? '0') || 0
  })
  return result
}

/**
 * `propertyId` comes from the tenant's saved analytics configuration; the
 * GA4_PROPERTY_ID env var remains the fallback so deployments that never set a
 * property in Settings keep working exactly as before.
 */
export async function fetchGA4KPIs(accessToken: string, explicitPropertyId?: string): Promise<GA4KPI[]> {
  const propertyId = explicitPropertyId || process.env.GA4_PROPERTY_ID
  if (!propertyId) {
    console.warn('[kpi-sync/ga4] no GA4 property configured (tenant prefs or GA4_PROPERTY_ID) — skipping')
    return []
  }

  const metricNames = ['sessions', 'newUsers', 'totalUsers', 'bounceRate', 'averageSessionDuration', 'screenPageViews']

  // Fetch current period (last 7 days) and previous period (8–14 days ago) in parallel
  const [current, previous] = await Promise.all([
    runGA4Report(accessToken, propertyId, '7daysAgo', 'today', metricNames),
    runGA4Report(accessToken, propertyId, '14daysAgo', '8daysAgo', metricNames),
  ])

  const kpis: GA4KPI[] = [
    (() => {
      const { trend, direction } = computeTrend(current.sessions, previous.sessions)
      return { id: 'ga4_sessions', label: 'Weekly Sessions', value: formatNum(current.sessions), unit: 'sessions', trendDirection: direction, rawValue: current.sessions, trend }
    })(),
    (() => {
      const { trend, direction } = computeTrend(current.newUsers, previous.newUsers)
      return { id: 'ga4_new_users', label: 'New Visitors', value: formatNum(current.newUsers), unit: 'users', trendDirection: direction, rawValue: current.newUsers, trend }
    })(),
    (() => {
      const bounceRatePct = current.bounceRate * 100
      const prevBounce = previous.bounceRate * 100
      // Lower bounce rate is better → invert direction
      const { trend, direction } = computeTrend(prevBounce, bounceRatePct)
      return { id: 'ga4_bounce_rate', label: 'Bounce Rate', value: `${bounceRatePct.toFixed(1)}%`, unit: '%', trendDirection: direction, rawValue: bounceRatePct, trend }
    })(),
    (() => {
      const { trend, direction } = computeTrend(current.screenPageViews, previous.screenPageViews)
      return { id: 'ga4_pageviews', label: 'Page Views', value: formatNum(current.screenPageViews), unit: 'views', trendDirection: direction, rawValue: current.screenPageViews, trend }
    })(),
  ]

  return kpis
}
