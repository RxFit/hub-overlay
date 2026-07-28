import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  listGSCSites,
  buildQueryBody,
  clampStartDate,
  clampRowLimit,
  hasAnonymizationRisk,
  querySearchConsole,
  resultToSheetRows,
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
} from './search-console'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stubJson(payload: unknown) {
  const calls: { url: string; body?: Record<string, unknown> }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined })
    return new Response(JSON.stringify(payload), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls }
}

const TODAY = new Date('2026-07-28T00:00:00Z')

describe('listGSCSites', () => {
  it('returns verified sites', async () => {
    stubJson({
      siteEntry: [
        { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
        { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteFullUser' },
      ],
    })

    const sites = await listGSCSites('tok')
    expect(sites.map(s => s.siteUrl)).toEqual(['https://example.com/', 'sc-domain:example.com'])
  })

  it('filters out unverified sites that would only 403 later', async () => {
    stubJson({
      siteEntry: [
        { siteUrl: 'https://ok.com/', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://nope.com/', permissionLevel: 'siteUnverifiedUser' },
      ],
    })

    const sites = await listGSCSites('tok')
    expect(sites.map(s => s.siteUrl)).toEqual(['https://ok.com/'])
  })

  it('handles an account with no sites', async () => {
    stubJson({})
    expect(await listGSCSites('tok')).toEqual([])
  })
})

describe('clampStartDate', () => {
  it('pulls a too-old start date up to the retention edge', () => {
    // Asking beyond ~16 months silently returns nothing for the missing span,
    // which reads as a traffic collapse rather than absent data.
    expect(clampStartDate('2020-01-01', TODAY)).toBe('2025-04-04')
  })

  it('leaves an in-window date untouched', () => {
    expect(clampStartDate('2026-07-01', TODAY)).toBe('2026-07-01')
  })

  it('falls back to the retention edge for an unparseable date', () => {
    expect(clampStartDate('not-a-date', TODAY)).toBe('2025-04-04')
  })
})

describe('clampRowLimit', () => {
  it('defaults and caps at the API maximum', () => {
    expect(clampRowLimit(undefined)).toBe(DEFAULT_ROW_LIMIT)
    expect(clampRowLimit(100_000)).toBe(MAX_ROW_LIMIT)
    expect(clampRowLimit(10)).toBe(10)
  })
})

describe('buildQueryBody', () => {
  it("requests fresh data so recent days don't read as zeros", () => {
    const body = buildQueryBody(
      { siteUrl: 'https://x.com/', startDate: '2026-07-01', endDate: '2026-07-28' },
      TODAY,
    )
    expect(body.dataState).toBe('all')
    expect(body.type).toBe('web')
    expect(body.dimensions).toEqual([])
  })

  it('passes dimensions and clamps the range', () => {
    const body = buildQueryBody(
      {
        siteUrl: 'https://x.com/',
        startDate: '2019-01-01',
        endDate: '2026-07-28',
        dimensions: ['query', 'page'],
        rowLimit: 5,
      },
      TODAY,
    )
    expect(body.dimensions).toEqual(['query', 'page'])
    expect(body.startDate).toBe('2025-04-04')
    expect(body.rowLimit).toBe(5)
  })
})

describe('hasAnonymizationRisk', () => {
  it('flags query-dimensioned requests', () => {
    expect(hasAnonymizationRisk(['query'])).toBe(true)
    expect(hasAnonymizationRisk(['query', 'page'])).toBe(true)
  })

  it('does not flag requests without the query dimension', () => {
    expect(hasAnonymizationRisk(['page', 'device'])).toBe(false)
    expect(hasAnonymizationRisk(undefined)).toBe(false)
  })
})

describe('querySearchConsole', () => {
  it('converts CTR from a fraction to a percentage', async () => {
    stubJson({ rows: [{ keys: ['/pricing'], clicks: 10, impressions: 200, ctr: 0.05, position: 4.2 }] })

    const result = await querySearchConsole(
      'tok',
      { siteUrl: 'https://x.com/', startDate: '2026-07-01', endDate: '2026-07-28', dimensions: ['page'] },
      TODAY,
    )

    expect(result.rows[0]).toMatchObject({ clicks: 10, impressions: 200, ctr: 5, position: 4.2 })
  })

  it('warns when totals will under-report due to anonymized rows', async () => {
    stubJson({ rows: [] })
    const result = await querySearchConsole(
      'tok',
      { siteUrl: 'https://x.com/', startDate: '2026-07-01', endDate: '2026-07-28', dimensions: ['query'] },
      TODAY,
    )
    expect(result.anonymizedDataWarning).toMatch(/under-report/)
  })

  it('carries no warning for a non-query request', async () => {
    stubJson({ rows: [] })
    const result = await querySearchConsole(
      'tok',
      { siteUrl: 'https://x.com/', startDate: '2026-07-01', endDate: '2026-07-28', dimensions: ['page'] },
      TODAY,
    )
    expect(result.anonymizedDataWarning).toBeUndefined()
  })

  it('URL-encodes the site so sc-domain properties work', async () => {
    const { calls } = stubJson({ rows: [] })
    await querySearchConsole(
      'tok',
      { siteUrl: 'sc-domain:example.com', startDate: '2026-07-01', endDate: '2026-07-28' },
      TODAY,
    )
    expect(calls[0].url).toContain(encodeURIComponent('sc-domain:example.com'))
  })

  it('defaults missing numeric fields to zero rather than undefined', async () => {
    stubJson({ rows: [{ keys: ['x'] }] })
    const result = await querySearchConsole(
      'tok',
      { siteUrl: 'https://x.com/', startDate: '2026-07-01', endDate: '2026-07-28' },
      TODAY,
    )
    expect(result.rows[0]).toMatchObject({ clicks: 0, impressions: 0, ctr: 0, position: 0 })
  })
})

describe('resultToSheetRows', () => {
  it('builds a header row plus formatted values', () => {
    const rows = resultToSheetRows({
      dimensions: ['page'],
      rows: [{ keys: ['/pricing'], clicks: 10, impressions: 200, ctr: 5, position: 4.23 }],
    })

    expect(rows).toEqual([
      ['page', 'clicks', 'impressions', 'ctr', 'position'],
      ['/pricing', '10', '200', '5.00%', '4.2'],
    ])
  })

  it('labels the single aggregate row when there are no dimensions', () => {
    const rows = resultToSheetRows({
      dimensions: [],
      rows: [{ keys: [], clicks: 1, impressions: 2, ctr: 50, position: 1 }],
    })
    expect(rows[0][0]).toBe('total')
  })
})
