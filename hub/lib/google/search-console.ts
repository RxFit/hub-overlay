/**
 * Google Search Console — site discovery and flexible search-analytics queries.
 *
 * The existing KPI source answers one question (four aggregate numbers for a
 * hardcoded site). This module exposes the dimensional queries people actually
 * want: which queries, which pages, which devices, which countries — and how
 * each moved.
 *
 * ── Constraints encoded here rather than left as folklore ──
 *  - **16-month window.** GSC keeps no more than ~16 months of data; asking for
 *    more silently returns nothing for the missing span, which reads as "our
 *    traffic collapsed" rather than "that data doesn't exist". `clampStartDate`
 *    makes the boundary explicit.
 *  - **`dataState: 'all'`** includes fresh (still-incomplete) data. Without it
 *    the last few days read as zeros, which looks like a cliff in any trend.
 *  - **Anonymized rows.** Combining `query` with other dimensions makes Google
 *    drop rows for rare queries entirely, so totals from a query-dimensioned
 *    request do NOT reconcile with aggregate totals. Callers are warned rather
 *    than left to discover it from mismatched numbers.
 */

import { googleFetch } from './client'

const GSC_BASE = 'https://www.googleapis.com/webmasters/v3'

/** Dimensions the search-analytics endpoint supports. */
export const GSC_DIMENSIONS = ['query', 'page', 'date', 'device', 'country', 'searchAppearance'] as const
export type GSCDimension = (typeof GSC_DIMENSIONS)[number]

export const DEFAULT_ROW_LIMIT = 50
/** API hard cap per request. */
export const MAX_ROW_LIMIT = 25_000
/** Search Console retains roughly 16 months. */
export const MAX_LOOKBACK_DAYS = 480

export interface GSCSite {
  siteUrl: string
  permissionLevel: string
}

export interface GSCQueryRequest {
  siteUrl: string
  startDate: string
  endDate: string
  dimensions?: GSCDimension[]
  rowLimit?: number
  /** 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews' */
  searchType?: string
}

export interface GSCRow {
  keys: string[]
  clicks: number
  impressions: number
  /** Percentage (0–100), converted from the API's 0–1 fraction. */
  ctr: number
  position: number
}

export interface GSCQueryResult {
  rows: GSCRow[]
  dimensions: GSCDimension[]
  /** Set when the result may omit rare rows — see the anonymization note. */
  anonymizedDataWarning?: string
}

/** List verified sites, for the settings picker. */
export async function listGSCSites(accessToken: string): Promise<GSCSite[]> {
  const data = await googleFetch<{
    siteEntry?: { siteUrl?: string; permissionLevel?: string }[]
  }>(`${GSC_BASE}/sites`, accessToken)

  return (data.siteEntry ?? [])
    .filter(entry => !!entry.siteUrl)
    .map(entry => ({
      siteUrl: entry.siteUrl!,
      permissionLevel: entry.permissionLevel ?? 'unknown',
    }))
    // A site the user can't read would only fail later with a confusing 403.
    .filter(site => site.permissionLevel !== 'siteUnverifiedUser')
}

/**
 * Pull a start date forward to the edge of GSC's retention window.
 *
 * Returns the clamped date; callers can compare it to the requested one to tell
 * the user their range was shortened rather than silently returning less data.
 */
export function clampStartDate(startDate: string, today = new Date()): string {
  const earliest = new Date(today)
  earliest.setDate(earliest.getDate() - MAX_LOOKBACK_DAYS)

  const requested = new Date(`${startDate}T00:00:00Z`)
  if (Number.isNaN(requested.getTime())) return earliest.toISOString().slice(0, 10)

  return requested < earliest ? earliest.toISOString().slice(0, 10) : startDate
}

export function clampRowLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_ROW_LIMIT
  return Math.min(Math.floor(limit), MAX_ROW_LIMIT)
}

/** Build the searchAnalytics.query body. Pure, for direct testing. */
export function buildQueryBody(request: GSCQueryRequest, today = new Date()): Record<string, unknown> {
  return {
    startDate: clampStartDate(request.startDate, today),
    endDate: request.endDate,
    dimensions: request.dimensions ?? [],
    rowLimit: clampRowLimit(request.rowLimit),
    type: request.searchType ?? 'web',
    // Include fresh data — otherwise recent days read as zeros.
    dataState: 'all',
  }
}

/**
 * True when the requested dimensions trigger Google's rare-query anonymization,
 * which drops rows and makes totals under-report.
 */
export function hasAnonymizationRisk(dimensions: GSCDimension[] | undefined): boolean {
  return !!dimensions?.includes('query')
}

/** Run a Search Console search-analytics query. */
export async function querySearchConsole(
  accessToken: string,
  request: GSCQueryRequest,
  today = new Date(),
): Promise<GSCQueryResult> {
  const body = buildQueryBody(request, today)

  const data = await googleFetch<{
    rows?: { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }[]
  }>(
    `${GSC_BASE}/sites/${encodeURIComponent(request.siteUrl)}/searchAnalytics/query`,
    accessToken,
    { method: 'POST', body: JSON.stringify(body) },
  )

  const rows: GSCRow[] = (data.rows ?? []).map(row => ({
    keys: row.keys ?? [],
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: (row.ctr ?? 0) * 100,
    position: row.position ?? 0,
  }))

  return {
    rows,
    dimensions: request.dimensions ?? [],
    ...(hasAnonymizationRisk(request.dimensions)
      ? {
          anonymizedDataWarning:
            'Rows for rare queries are omitted by Google, so these totals under-report and will not match site-wide aggregates.',
        }
      : {}),
  }
}

/** Convert results to rows for `createFormattedSheet`. */
export function resultToSheetRows(result: GSCQueryResult): string[][] {
  const dimensionHeaders = result.dimensions.length ? result.dimensions : ['total']
  const headers = [...dimensionHeaders, 'clicks', 'impressions', 'ctr', 'position']

  return [
    headers,
    ...result.rows.map(row => [
      ...dimensionHeaders.map((_, i) => row.keys[i] ?? ''),
      String(row.clicks),
      String(row.impressions),
      `${row.ctr.toFixed(2)}%`,
      row.position.toFixed(1),
    ]),
  ]
}
