/**
 * Google Search Console API — fetches SEO performance metrics.
 * Uses the authenticated user's Google OAuth access token.
 *
 * Requires: GSC_SITE_URL env var + webmasters.readonly OAuth scope.
 */

export interface GSCKPIs {
  id: string
  label: string
  value: string
  unit?: string
  trend: string
  trendDirection: 'up' | 'down' | 'neutral'
  rawValue: number
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function isoDate(daysAgo: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString().split('T')[0]
}

function computeTrend(current: number, previous: number, invertGood = false): { trend: string; direction: 'up' | 'down' | 'neutral' } {
  if (!previous || previous === 0) return { trend: '—', direction: 'neutral' }
  const pct = ((current - previous) / previous) * 100
  const sign = pct >= 0 ? '+' : ''
  const naturalDir: 'up' | 'down' | 'neutral' = pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'neutral'
  return {
    trend: `${sign}${pct.toFixed(1)}%`,
    direction: invertGood ? (naturalDir === 'up' ? 'down' : naturalDir === 'down' ? 'up' : 'neutral') : naturalDir,
  }
}

interface GSCSearchAnalyticsRow {
  clicks: number
  impressions: number
  ctr: number
  position: number
}

async function querySearchConsole(
  accessToken: string,
  siteUrl: string,
  startDate: string,
  endDate: string
): Promise<GSCSearchAnalyticsRow> {
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: [],        // aggregate across all dimensions
        rowLimit: 1,
        type: 'web',
      }),
    }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`GSC API ${res.status}: ${err.slice(0, 200)}`)
  }

  const data = await res.json()
  const row = data.rows?.[0]
  if (!row) return { clicks: 0, impressions: 0, ctr: 0, position: 0 }
  return {
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: (row.ctr ?? 0) * 100,          // convert to percentage
    position: row.position ?? 0,
  }
}

/**
 * `siteUrl` comes from the tenant's saved analytics configuration; the
 * GSC_SITE_URL env var remains the fallback so existing deployments are
 * unaffected until an admin picks a site in Settings.
 */
export async function fetchGSCKPIs(accessToken: string, explicitSiteUrl?: string): Promise<GSCKPIs[]> {
  const siteUrl = explicitSiteUrl || process.env.GSC_SITE_URL
  if (!siteUrl) {
    console.warn('[kpi-sync/gsc] no Search Console site configured (tenant prefs or GSC_SITE_URL) — skipping')
    return []
  }

  // Fetch current 28 days + previous 28 days in parallel
  const [current, previous] = await Promise.all([
    querySearchConsole(accessToken, siteUrl, isoDate(28), isoDate(1)),
    querySearchConsole(accessToken, siteUrl, isoDate(56), isoDate(29)),
  ])

  const clicksTrend = computeTrend(current.clicks, previous.clicks)
  const impressionsTrend = computeTrend(current.impressions, previous.impressions)
  const ctrTrend = computeTrend(current.ctr, previous.ctr)
  // Lower avg position = better ranking → invert
  const positionTrend = computeTrend(current.position, previous.position, true)

  return [
    {
      id: 'gsc_clicks',
      label: 'Search Clicks (28d)',
      value: formatNum(current.clicks),
      unit: 'clicks',
      trend: clicksTrend.trend,
      trendDirection: clicksTrend.direction,
      rawValue: current.clicks,
    },
    {
      id: 'gsc_impressions',
      label: 'Impressions (28d)',
      value: formatNum(current.impressions),
      unit: 'impressions',
      trend: impressionsTrend.trend,
      trendDirection: impressionsTrend.direction,
      rawValue: current.impressions,
    },
    {
      id: 'gsc_ctr',
      label: 'Click-Through Rate',
      value: `${current.ctr.toFixed(2)}%`,
      unit: '%',
      trend: ctrTrend.trend,
      trendDirection: ctrTrend.direction,
      rawValue: current.ctr,
    },
    {
      id: 'gsc_position',
      label: 'Avg Search Position',
      value: current.position.toFixed(1),
      unit: '#',
      trend: positionTrend.trend,
      trendDirection: positionTrend.direction,
      rawValue: current.position,
    },
  ]
}
