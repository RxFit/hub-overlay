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
  /** Set when `repair: true` adjusted the request before running (renamed /
   *  dropped fields) — callers disclose this so the answer matches the data. */
  repairs?: GA4FieldRepairs
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
 * Property metadata changes about as often as someone edits their GA4 custom
 * definitions — i.e. rarely — but validation runs on EVERY model-driven query.
 * Without a cache, each analytics question would cost two API calls instead of
 * one, doubling quota consumption to re-learn the same field list.
 *
 * In-process is sufficient: the Hub runs as a single Cloud Run service, and a
 * cold start simply re-fetches. Keyed by property so multi-tenant lookups can't
 * cross-contaminate.
 */
export const METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const metadataCache = new Map<string, { fetchedAt: number; value: GA4Metadata }>()

/** Drop cached metadata — exported for tests. */
export function __clearGA4MetadataCache(): void {
  metadataCache.clear()
}

/**
 * Fetch the property's valid dimension/metric API names, including custom
 * definitions (which vary per property and cannot be hardcoded).
 */
export async function fetchGA4Metadata(
  accessToken: string,
  propertyId: string,
  now: number = Date.now(),
): Promise<GA4Metadata> {
  const cached = metadataCache.get(propertyId)
  if (cached && now - cached.fetchedAt < METADATA_CACHE_TTL_MS) return cached.value

  const data = await googleFetch<{
    dimensions?: { apiName?: string }[]
    metrics?: { apiName?: string }[]
  }>(`${DATA_BASE}/properties/${encodeURIComponent(propertyId)}/metadata`, accessToken)

  const value: GA4Metadata = {
    dimensions: new Set((data.dimensions ?? []).map(d => d.apiName).filter((n): n is string => !!n)),
    metrics: new Set((data.metrics ?? []).map(m => m.apiName).filter((n): n is string => !!n)),
  }
  metadataCache.set(propertyId, { fetchedAt: now, value })
  return value
}

/**
 * Metric names Google RENAMED in the Data API. Model-proposed queries keep
 * using the old names — they are all over training data, older docs, and the
 * UA-era vocabulary — and one unknown name used to reject the entire report
 * (the live "issue with the metric configuration" failure, 2026-08-14). An
 * alias is applied only when the property's own metadata confirms the target
 * exists, so a repair can never introduce a new invalid name.
 *
 * users → activeUsers deliberately: GA4's own UI labels activeUsers "Users".
 */
export const GA4_METRIC_ALIASES: Record<string, string> = {
  conversions: 'keyEvents',
  users: 'activeUsers',
  pageviews: 'screenPageViews',
  views: 'screenPageViews',
}

export interface GA4FieldRepairs {
  renamedMetrics: { from: string; to: string }[]
  droppedMetrics: string[]
  droppedDimensions: string[]
  droppedOrderBy?: string
}

/** Case-insensitive lookup table for a metadata name set ("Sessions" →
 *  "sessions"), so a casing slip repairs instead of rejecting. */
function canonicalIndex(names: Set<string>): Map<string, string> {
  const index = new Map<string, string>()
  for (const name of names) index.set(name.toLowerCase(), name)
  return index
}

/**
 * Repair a report request against the property's metadata instead of rejecting
 * it outright. Per unknown name, in order: exact match keeps it; a
 * case-insensitive match restores canonical casing; a known rename maps it
 * (only when the target exists on this property); otherwise it is dropped and
 * recorded. `orderByMetric` follows its metric's rename and is dropped when its
 * metric is. Pure and exported for direct testing.
 *
 * Returns `repairs: null` when nothing needed fixing. Callers must check the
 * repaired request still has at least one metric — an all-unknown metric list
 * is not repairable and should surface the validation error instead.
 */
export function repairGA4Fields(
  request: GA4ReportRequest,
  metadata: GA4Metadata,
): { request: GA4ReportRequest; repairs: GA4FieldRepairs | null } {
  const metricIndex = canonicalIndex(metadata.metrics)
  const dimensionIndex = canonicalIndex(metadata.dimensions)

  const repairs: GA4FieldRepairs = { renamedMetrics: [], droppedMetrics: [], droppedDimensions: [] }
  const renameMap = new Map<string, string>()

  const metrics: string[] = []
  for (const name of request.metrics) {
    if (metadata.metrics.has(name)) {
      // Dedupe exact matches too: a hedging model can propose both the old
      // and new name ("pageviews" AND "screenPageViews"), and GA4 400s on a
      // duplicated metric — which would turn a repair into a new failure.
      if (!metrics.includes(name)) metrics.push(name)
      continue
    }
    const lower = name.toLowerCase()
    const resolved =
      metricIndex.get(lower) ??
      (() => {
        const alias = GA4_METRIC_ALIASES[name] ?? GA4_METRIC_ALIASES[lower]
        return alias && metadata.metrics.has(alias) ? alias : undefined
      })()
    if (resolved && !metrics.includes(resolved)) {
      metrics.push(resolved)
      repairs.renamedMetrics.push({ from: name, to: resolved })
      renameMap.set(name, resolved)
    } else if (resolved) {
      // Renamed into a metric already requested — the duplicate is dropped.
      repairs.renamedMetrics.push({ from: name, to: resolved })
      renameMap.set(name, resolved)
    } else {
      repairs.droppedMetrics.push(name)
    }
  }

  // Dimensions: exact match keeps, a casing slip restores canonical form,
  // anything else is dropped and recorded. (No alias map — Google has not
  // renamed dimensions the way it renamed metrics.)
  let dimensions: string[] | undefined
  if (request.dimensions) {
    dimensions = []
    for (const name of request.dimensions) {
      if (metadata.dimensions.has(name)) {
        if (!dimensions.includes(name)) dimensions.push(name)
        continue
      }
      const canonical = dimensionIndex.get(name.toLowerCase())
      if (canonical) {
        if (!dimensions.includes(canonical)) dimensions.push(canonical)
      } else {
        repairs.droppedDimensions.push(name)
      }
    }
  }

  let orderByMetric = request.orderByMetric
  if (orderByMetric && !metrics.includes(orderByMetric)) {
    // Resolution order mirrors the metric pass: an already-applied rename,
    // then canonical casing, then the alias table — and the result counts
    // only if it names a metric actually in the (repaired) request, because
    // GA4 rejects an orderBy that references a non-requested metric.
    const resolved =
      renameMap.get(orderByMetric) ??
      metricIndex.get(orderByMetric.toLowerCase()) ??
      GA4_METRIC_ALIASES[orderByMetric] ??
      GA4_METRIC_ALIASES[orderByMetric.toLowerCase()]
    if (resolved && metrics.includes(resolved)) {
      orderByMetric = resolved
    } else {
      repairs.droppedOrderBy = orderByMetric
      orderByMetric = undefined
    }
  }

  const changed =
    repairs.renamedMetrics.length > 0 ||
    repairs.droppedMetrics.length > 0 ||
    repairs.droppedDimensions.length > 0 ||
    repairs.droppedOrderBy !== undefined

  return {
    request: { ...request, metrics, dimensions, orderByMetric },
    repairs: changed ? repairs : null,
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
 *
 * `repair: true` (the model-facing read tool) fixes what it can instead of
 * rejecting the whole report over one bad name: casing slips are restored,
 * renamed metrics (GA4_METRIC_ALIASES) are mapped, unknown leftovers are
 * dropped — and the result carries `repairs` so the caller can disclose what
 * changed. The strict default is unchanged for programmatic callers (the
 * /api/google/analytics/report route), where a loud validation error is the
 * correctable contract.
 */
export async function runGA4Report(
  accessToken: string,
  request: GA4ReportRequest,
  opts: { validate?: boolean; repair?: boolean } = {},
): Promise<GA4ReportResult> {
  let effective = request
  let repairs: GA4FieldRepairs | null = null

  if (opts.validate !== false) {
    const metadata = await fetchGA4Metadata(accessToken, request.propertyId)
    const problem = validateFields(request, metadata)
    if (problem && !opts.repair) {
      throw new Error(`GA4 report rejected before sending — ${problem}`)
    }
    if (opts.repair) {
      // Run repair UNCONDITIONALLY under the flag, not only when validation
      // flagged a problem: validateFields does not cover orderByMetric, so an
      // orderBy-only slip ("keyEvents" requested, ordered by "conversions")
      // validates clean yet 400s at Google. repairGA4Fields returns
      // repairs:null when nothing changed, so clean requests are untouched.
      const repaired = repairGA4Fields(request, metadata)
      // Nothing usable survived: repair cannot conjure a metric, so surface
      // the original, name-listing validation error.
      if (repaired.request.metrics.length === 0) {
        throw new Error(
          `GA4 report rejected before sending — ${problem ?? `unknown metric(s): ${request.metrics.join(', ')}`}`,
        )
      }
      effective = repaired.request
      repairs = repaired.repairs
    }
  }

  const raw = await googleFetch<RawReportResponse>(
    `${DATA_BASE}/properties/${encodeURIComponent(effective.propertyId)}:runReport`,
    accessToken,
    { method: 'POST', body: JSON.stringify(buildReportBody(effective)) },
  )

  return { ...shapeReport(raw), ...(repairs ? { repairs } : {}) }
}

/** Convert a report to rows for `createFormattedSheet` (header row + values). */
export function reportToSheetRows(result: GA4ReportResult): string[][] {
  const headers = [...result.dimensionHeaders, ...result.metricHeaders]
  if (!headers.length) return []
  return [headers, ...result.rows.map(row => headers.map(h => row[h] ?? ''))]
}
