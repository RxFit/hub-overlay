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
