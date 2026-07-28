/**
 * Google Analytics 4 — property discovery and flexible reporting.
 *
 * What existed before was a single hardcoded `GA4_PROPERTY_ID` env var feeding
 * four fixed 7-day KPI tiles. That answers exactly one question, for exactly
 * one property. This module supports the questions people actually ask — "which
 * pages drove the most conversions last month?" — by exposing the Data API's
 * real shape (dimensions, metrics, date ranges, ordering) behind a checked
 * interface.
 *
 * ── Quota is the constraint that shapes this file ──
 * The Data API bills per-property "tokens", not per-request: Standard tier gets
 * 40,000/property/hour with a 10-concurrent-request cap, and a broad query
 * costs dramatically more than a narrow one. So:
 *  - every report requests `returnPropertyQuota` and surfaces what it consumed,
 *    which is the only way a caller can act on remaining budget;
 *  - `limit` is clamped, because an unbounded row count is the easiest way to
 *    burn an hour's tokens on one question;
 *  - dimension/metric names are validated against the property's own metadata
 *    before the call, so a hallucinated field becomes a correctable error
 *    instead of an opaque 400 that still cost a round trip.
 */

import { googleFetch } from './client'

const ADMIN_BASE = 'https://analyticsadmin.googleapis.com/v1beta'
const DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta'

/** Rows returned per report. High enough for a real answer, low enough that a
 *  single question cannot torch the hourly token budget. */
export const DEFAULT_ROW_LIMIT = 50
export const MAX_ROW_LIMIT = 500

export interface GA4Property {
  /** Numeric id, no "properties/" prefix — what callers store and pass back. */
  propertyId: string
  displayName: string
  accountName: string
}

export interface GA4ReportRequest {
  propertyId: string
  startDate: string
  endDate: string
  metrics: string[]
  dimensions?: string[]
  limit?: number
  orderByMetric?: string
  orderDescending?: boolean
}

export interface GA4ReportResult {
  dimensionHeaders: string[]
  metricHeaders: string[]
  rows: Record<string, string>[]
  rowCount: number
  /** Tokens consumed/remaining, when Google reported them. */
  quota?: { tokensConsumed?: number; tokensRemaining?: number }
}

/**
 * List every GA4 property the signed-in user can read, for the settings picker.
 *
 * `accountSummaries` is the right endpoint here: one call returns accounts and
 * their properties together, so a picker needs no N+1 walk.
 */
export async function listGA4Properties(accessToken: string): Promise<GA4Property[]> {
  const data = await googleFetch<{
    accountSummaries?: {
      displayName?: string
      propertySummaries?: { property?: string; displayName?: string }[]
    }[]
  }>(`${ADMIN_BASE}/accountSummaries?pageSize=200`, accessToken)

  const properties: GA4Property[] = []
  for (const account of data.accountSummaries ?? []) {
    for (const summary of account.propertySummaries ?? []) {
      // `property` arrives as "properties/123456"; callers want the bare id.
      const propertyId = summary.property?.split('/')[1]
      if (!propertyId) continue
      properties.push({
        propertyId,
        displayName: summary.displayName ?? propertyId,
        accountName: account.displayName ?? '',
      })
    }
  }
  return properties
}

export interface GA4Metadata {
  dimensions: Set<string>
  metrics: Set<string>
}

/**
 * Fetch the property's valid dimension/metric API names, including custom
 * definitions (which vary per property and cannot be hardcoded).
 */
export async function fetchGA4Metadata(accessToken: string, propertyId: string): Promise<GA4Metadata> {
  const data = await googleFetch<{
    dimensions?: { apiName?: string }[]
    metrics?: { apiName?: string }[]
  }>(`${DATA_BASE}/properties/${encodeURIComponent(propertyId)}/metadata`, accessToken)

  return {
    dimensions: new Set((data.dimensions ?? []).map(d => d.apiName).filter((n): n is string => !!n)),
    metrics: new Set((data.metrics ?? []).map(m => m.apiName).filter((n): n is string => !!n)),
  }
}

/**
 * Check requested fields against the property's metadata, returning a message
 * naming what was wrong. Exported for direct testing.
 *
 * The message deliberately lists the offending names: it is fed back to whoever
 * built the query so the next attempt can be right, rather than surfacing as a
 * generic "Google said 400".
 */
export function validateFields(request: GA4ReportRequest, metadata: GA4Metadata): string | null {
  const badMetrics = request.metrics.filter(m => !metadata.metrics.has(m))
  const badDimensions = (request.dimensions ?? []).filter(d => !metadata.dimensions.has(d))

  const problems: string[] = []
  if (badMetrics.length) problems.push(`unknown metric(s): ${badMetrics.join(', ')}`)
  if (badDimensions.length) problems.push(`unknown dimension(s): ${badDimensions.join(', ')}`)
  return problems.length ? problems.join('; ') : null
}

/** Clamp a requested row limit into the supported window. */
export function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_ROW_LIMIT
  return Math.min(Math.floor(limit), MAX_ROW_LIMIT)
}

/**
 * Build the `runReport` body. Pure, so the request shape is unit-testable
 * without touching the network.
 */
export function buildReportBody(request: GA4ReportRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    dateRanges: [{ startDate: request.startDate, endDate: request.endDate }],
    metrics: request.metrics.map(name => ({ name })),
    limit: clampLimit(request.limit),
    // The only way callers can see what a question cost.
    returnPropertyQuota: true,
  }

  if (request.dimensions?.length) {
    body.dimensions = request.dimensions.map(name => ({ name }))
  }

  if (request.orderByMetric) {
    body.orderBys = [
      {
        metric: { metricName: request.orderByMetric },
        desc: request.orderDescending ?? true,
      },
    ]
  }

  return body
}

interface RawReportResponse {
  dimensionHeaders?: { name?: string }[]
  metricHeaders?: { name?: string }[]
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[]
  rowCount?: number
  propertyQuota?: {
    tokensPerHour?: { consumed?: number; remaining?: number }
  }
}

/**
 * Flatten GA4's parallel header/value arrays into plain row objects keyed by
 * field name — far easier to render, summarize or export to a Sheet than the
 * positional wire format.
 */
export function shapeReport(raw: RawReportResponse): GA4ReportResult {
  const dimensionHeaders = (raw.dimensionHeaders ?? []).map(h => h.name ?? '')
  const metricHeaders = (raw.metricHeaders ?? []).map(h => h.name ?? '')

  const rows = (raw.rows ?? []).map(row => {
    const out: Record<string, string> = {}
    dimensionHeaders.forEach((name, i) => {
      out[name] = row.dimensionValues?.[i]?.value ?? ''
    })
    metricHeaders.forEach((name, i) => {
      out[name] = row.metricValues?.[i]?.value ?? '0'
    })
    return out
  })

  return {
    dimensionHeaders,
    metricHeaders,
    rows,
    rowCount: raw.rowCount ?? rows.length,
    quota: raw.propertyQuota?.tokensPerHour
      ? {
          tokensConsumed: raw.propertyQuota.tokensPerHour.consumed,
          tokensRemaining: raw.propertyQuota.tokensPerHour.remaining,
        }
      : undefined,
  }
}

/**
 * Run a GA4 report.
 *
 * `validate: false` skips the metadata round trip for queries built from known
 * -good fields (the KPI sync), where the extra call is pure overhead.
 */
export async function runGA4Report(
  accessToken: string,
  request: GA4ReportRequest,
  opts: { validate?: boolean } = {},
): Promise<GA4ReportResult> {
  if (opts.validate !== false) {
    const metadata = await fetchGA4Metadata(accessToken, request.propertyId)
    const problem = validateFields(request, metadata)
    if (problem) {
      throw new Error(`GA4 report rejected before sending — ${problem}`)
    }
  }

  const raw = await googleFetch<RawReportResponse>(
    `${DATA_BASE}/properties/${encodeURIComponent(request.propertyId)}:runReport`,
    accessToken,
    { method: 'POST', body: JSON.stringify(buildReportBody(request)) },
  )

  return shapeReport(raw)
}

/** Convert a report to rows for `createFormattedSheet` (header row + values). */
export function reportToSheetRows(result: GA4ReportResult): string[][] {
  const headers = [...result.dimensionHeaders, ...result.metricHeaders]
  if (!headers.length) return []
  return [headers, ...result.rows.map(row => headers.map(h => row[h] ?? ''))]
}
