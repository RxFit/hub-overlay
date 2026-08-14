import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  listGA4Properties,
  buildReportBody,
  validateFields,
  clampLimit,
  shapeReport,
  runGA4Report,
  reportToSheetRows,
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
  __clearGA4MetadataCache,
} from './analytics'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // Metadata is cached process-wide; clear it so call-count assertions measure
  // this test's calls rather than whatever a previous test warmed.
  __clearGA4MetadataCache()
})

function stubJson(payloads: unknown[]) {
  const calls: { url: string; body?: Record<string, unknown> }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined })
    const next = payloads.shift() ?? {}
    return new Response(JSON.stringify(next), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

const metadata = {
  dimensions: new Set(['pagePath', 'country']),
  metrics: new Set(['sessions', 'conversions']),
}

describe('listGA4Properties', () => {
  it('flattens account summaries and strips the properties/ prefix', async () => {
    stubJson([
      {
        accountSummaries: [
          {
            displayName: 'RxFit',
            propertySummaries: [
              { property: 'properties/123456', displayName: 'Main site' },
              { property: 'properties/789', displayName: 'App' },
            ],
          },
        ],
      },
    ])

    const properties = await listGA4Properties('tok')

    // Callers store the bare id and pass it straight back into report calls.
    expect(properties).toEqual([
      { propertyId: '123456', displayName: 'Main site', accountName: 'RxFit' },
      { propertyId: '789', displayName: 'App', accountName: 'RxFit' },
    ])
  })

  it('skips malformed entries instead of failing the picker', async () => {
    stubJson([{ accountSummaries: [{ propertySummaries: [{ displayName: 'no id' }] }] }])
    expect(await listGA4Properties('tok')).toEqual([])
  })

  it('returns an empty list when the user has no properties', async () => {
    stubJson([{}])
    expect(await listGA4Properties('tok')).toEqual([])
  })
})

describe('validateFields', () => {
  it('accepts known dimensions and metrics', () => {
    const request = {
      propertyId: '1',
      startDate: '2026-07-01',
      endDate: '2026-07-28',
      metrics: ['sessions'],
      dimensions: ['pagePath'],
    }
    expect(validateFields(request, metadata)).toBeNull()
  })

  it('names the offending fields so the query can be corrected', () => {
    const request = {
      propertyId: '1',
      startDate: '2026-07-01',
      endDate: '2026-07-28',
      metrics: ['sessions', 'madeUpMetric'],
      dimensions: ['notADimension'],
    }

    const problem = validateFields(request, metadata)
    expect(problem).toContain('madeUpMetric')
    expect(problem).toContain('notADimension')
  })
})

describe('clampLimit', () => {
  it('defaults when unset and caps runaway values', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_ROW_LIMIT)
    expect(clampLimit(0)).toBe(DEFAULT_ROW_LIMIT)
    expect(clampLimit(-5)).toBe(DEFAULT_ROW_LIMIT)
    // An unbounded row count is the easiest way to burn the hourly token budget.
    expect(clampLimit(999_999)).toBe(MAX_ROW_LIMIT)
    expect(clampLimit(25)).toBe(25)
  })
})

describe('buildReportBody', () => {
  it('always asks for quota so callers can see what a question cost', () => {
    const body = buildReportBody({
      propertyId: '1',
      startDate: '2026-07-01',
      endDate: '2026-07-28',
      metrics: ['sessions'],
    })
    expect(body.returnPropertyQuota).toBe(true)
    expect(body.dateRanges).toEqual([{ startDate: '2026-07-01', endDate: '2026-07-28' }])
    expect(body.metrics).toEqual([{ name: 'sessions' }])
  })

  it('omits dimensions entirely when none are requested', () => {
    const body = buildReportBody({ propertyId: '1', startDate: 'a', endDate: 'b', metrics: ['sessions'] })
    expect(body).not.toHaveProperty('dimensions')
  })

  it('builds a descending order clause by default', () => {
    const body = buildReportBody({
      propertyId: '1',
      startDate: 'a',
      endDate: 'b',
      metrics: ['sessions'],
      orderByMetric: 'sessions',
    })
    expect(body.orderBys).toEqual([{ metric: { metricName: 'sessions' }, desc: true }])
  })
})

describe('shapeReport', () => {
  it('flattens parallel header/value arrays into keyed rows', () => {
    const result = shapeReport({
      dimensionHeaders: [{ name: 'pagePath' }],
      metricHeaders: [{ name: 'sessions' }],
      rows: [
        { dimensionValues: [{ value: '/pricing' }], metricValues: [{ value: '120' }] },
        { dimensionValues: [{ value: '/blog' }], metricValues: [{ value: '80' }] },
      ],
      rowCount: 2,
    })

    expect(result.rows).toEqual([
      { pagePath: '/pricing', sessions: '120' },
      { pagePath: '/blog', sessions: '80' },
    ])
  })

  it('surfaces quota consumption when Google reports it', () => {
    const result = shapeReport({
      metricHeaders: [{ name: 'sessions' }],
      rows: [],
      propertyQuota: { tokensPerHour: { consumed: 12, remaining: 39_988 } },
    })
    expect(result.quota).toEqual({ tokensConsumed: 12, tokensRemaining: 39_988 })
  })

  it('handles an empty result set', () => {
    const result = shapeReport({})
    expect(result.rows).toEqual([])
    expect(result.rowCount).toBe(0)
  })
})

describe('runGA4Report', () => {
  it('rejects a hallucinated field BEFORE spending the API call', async () => {
    const { calls } = stubJson([{ dimensions: [{ apiName: 'pagePath' }], metrics: [{ apiName: 'sessions' }] }])

    await expect(
      runGA4Report('tok', {
        propertyId: '1',
        startDate: 'a',
        endDate: 'b',
        metrics: ['notReal'],
      }),
    ).rejects.toThrow(/notReal/)

    // Only the metadata lookup happened — no runReport was sent.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/metadata')
  })

  it('skips the metadata round trip when validation is disabled', async () => {
    const { calls } = stubJson([{ rows: [] }])

    await runGA4Report(
      'tok',
      { propertyId: '1', startDate: 'a', endDate: 'b', metrics: ['sessions'] },
      { validate: false },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain(':runReport')
  })
})

describe('reportToSheetRows', () => {
  it('produces a header row followed by aligned values', () => {
    const rows = reportToSheetRows({
      dimensionHeaders: ['pagePath'],
      metricHeaders: ['sessions'],
      rows: [{ pagePath: '/pricing', sessions: '120' }],
      rowCount: 1,
    })

    expect(rows).toEqual([
      ['pagePath', 'sessions'],
      ['/pricing', '120'],
    ])
  })

  it('returns nothing for a headerless result', () => {
    expect(reportToSheetRows({ dimensionHeaders: [], metricHeaders: [], rows: [], rowCount: 0 })).toEqual([])
  })
})

/* ── Field repair (the "issue with the metric configuration" fix) ──
   One stale name (Google renamed "conversions" → "keyEvents") used to reject
   the entire report; the model then answered with generic GA4 education
   instead of data. repair fixes what it can, drops what it can't, and reports
   both — the strict validation contract stays the default. */
import { repairGA4Fields, GA4_METRIC_ALIASES, type GA4Metadata } from './analytics'

const repairMeta: GA4Metadata = {
  dimensions: new Set(['pagePath', 'country', 'date']),
  metrics: new Set(['sessions', 'keyEvents', 'activeUsers', 'screenPageViews']),
}

describe('repairGA4Fields', () => {
  const req = (over: Record<string, unknown>) => ({
    propertyId: '1',
    startDate: '7daysAgo',
    endDate: 'today',
    metrics: ['sessions'],
    ...over,
  })

  it('maps renamed metrics via the alias table, only when the target exists on the property', () => {
    const { request, repairs } = repairGA4Fields(
      req({ metrics: ['sessions', 'conversions', 'pageviews'] }),
      repairMeta,
    )
    expect(request.metrics).toEqual(['sessions', 'keyEvents', 'screenPageViews'])
    expect(repairs?.renamedMetrics).toEqual([
      { from: 'conversions', to: 'keyEvents' },
      { from: 'pageviews', to: 'screenPageViews' },
    ])
    expect(repairs?.droppedMetrics).toEqual([])
  })

  it('restores canonical casing before consulting aliases', () => {
    const { request, repairs } = repairGA4Fields(req({ metrics: ['Sessions'] }), repairMeta)
    expect(request.metrics).toEqual(['sessions'])
    expect(repairs?.renamedMetrics).toEqual([{ from: 'Sessions', to: 'sessions' }])
  })

  it('drops metrics that neither match nor alias, keeping the valid remainder', () => {
    const { request, repairs } = repairGA4Fields(
      req({ metrics: ['sessions', 'madeUpMetric'] }),
      repairMeta,
    )
    expect(request.metrics).toEqual(['sessions'])
    expect(repairs?.droppedMetrics).toEqual(['madeUpMetric'])
  })

  it('deduplicates a rename that collides with an already-requested metric', () => {
    const { request } = repairGA4Fields(
      req({ metrics: ['keyEvents', 'conversions'] }),
      repairMeta,
    )
    expect(request.metrics).toEqual(['keyEvents'])
  })

  it('orderByMetric follows its rename and is dropped with its metric', () => {
    const renamed = repairGA4Fields(
      req({ metrics: ['conversions'], orderByMetric: 'conversions' }),
      repairMeta,
    )
    expect(renamed.request.orderByMetric).toBe('keyEvents')

    const dropped = repairGA4Fields(
      req({ metrics: ['sessions', 'bogus'], orderByMetric: 'bogus' }),
      repairMeta,
    )
    expect(dropped.request.orderByMetric).toBeUndefined()
    expect(dropped.repairs?.droppedOrderBy).toBe('bogus')
  })

  it('repairs dimension casing and drops unknown dimensions', () => {
    const { request, repairs } = repairGA4Fields(
      req({ dimensions: ['PagePath', 'country', 'nonsense'] }),
      repairMeta,
    )
    expect(request.dimensions).toEqual(['pagePath', 'country'])
    expect(repairs?.droppedDimensions).toEqual(['nonsense'])
  })

  it('returns repairs: null when nothing needed fixing', () => {
    const { request, repairs } = repairGA4Fields(
      req({ metrics: ['sessions'], dimensions: ['pagePath'] }),
      repairMeta,
    )
    expect(repairs).toBeNull()
    expect(request.metrics).toEqual(['sessions'])
  })

  it('alias table maps only to names Google actually renamed toward', () => {
    // Guards against someone "extending" the table with guesses: every alias
    // target must be a real current GA4 Data API name.
    expect(Object.values(GA4_METRIC_ALIASES)).toEqual(
      expect.arrayContaining(['keyEvents', 'activeUsers', 'screenPageViews']),
    )
  })
})

describe('runGA4Report — repair option', () => {
  const metaPayload = {
    dimensions: [{ apiName: 'pagePath' }],
    metrics: [{ apiName: 'sessions' }, { apiName: 'keyEvents' }],
  }

  it('repairs a renamed metric, runs the report, and reports the adjustment', async () => {
    const { calls } = stubJson([metaPayload, { rows: [], rowCount: 0 }])
    const result = await runGA4Report(
      'tok',
      { propertyId: 'p9', startDate: '7daysAgo', endDate: 'today', metrics: ['conversions'] },
      { repair: true },
    )
    // The body sent to Google carries the REPAIRED name.
    expect(calls[1].body?.metrics).toEqual([{ name: 'keyEvents' }])
    expect(result.repairs?.renamedMetrics).toEqual([{ from: 'conversions', to: 'keyEvents' }])
  })

  it('still throws the name-listing validation error when nothing survives repair', async () => {
    stubJson([metaPayload])
    await expect(
      runGA4Report(
        'tok',
        { propertyId: 'p10', startDate: '7daysAgo', endDate: 'today', metrics: ['bogusOnly'] },
        { repair: true },
      ),
    ).rejects.toThrow(/unknown metric\(s\): bogusOnly/)
  })

  it('keeps the strict default: without repair, one bad name rejects the report', async () => {
    stubJson([metaPayload])
    await expect(
      runGA4Report('tok', {
        propertyId: 'p11',
        startDate: '7daysAgo',
        endDate: 'today',
        metrics: ['conversions'],
      }),
    ).rejects.toThrow(/unknown metric\(s\): conversions/)
  })

  it('attaches no repairs field when the request was already valid', async () => {
    stubJson([metaPayload, { rows: [], rowCount: 0 }])
    const result = await runGA4Report(
      'tok',
      { propertyId: 'p12', startDate: '7daysAgo', endDate: 'today', metrics: ['sessions'] },
      { repair: true },
    )
    expect(result.repairs).toBeUndefined()
  })
})
