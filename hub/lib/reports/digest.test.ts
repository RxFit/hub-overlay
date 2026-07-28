import { describe, it, expect } from 'vitest'
import { buildDigestMarkdown, formatDelta } from './digest'
import type { GA4ReportResult } from '../google/analytics'
import type { GSCQueryResult } from '../google/search-console'

const ga4 = (sessions: number): GA4ReportResult => ({
  dimensionHeaders: [],
  metricHeaders: ['sessions'],
  rows: [{ sessions: String(sessions) }],
  rowCount: 1,
})

const gsc = (over: Partial<GSCQueryResult> = {}): GSCQueryResult => ({
  dimensions: [],
  rows: [{ keys: [], clicks: 100, impressions: 2000, ctr: 5, position: 8 }],
  ...over,
})

const base = { title: 'Weekly digest', startDate: '2026-07-21', endDate: '2026-07-27' }

describe('formatDelta', () => {
  it('signs the change', () => {
    expect(formatDelta(110, 100)).toBe('+10.0%')
    expect(formatDelta(90, 100)).toBe('-10.0%')
  })

  it('returns a dash when the previous period was zero', () => {
    // A percentage against nothing is not information — printing "+100%" makes
    // a first week of data look like explosive growth.
    expect(formatDelta(50, 0)).toBe('—')
  })
})

describe('buildDigestMarkdown', () => {
  it('leads with the title and reporting period', () => {
    const md = buildDigestMarkdown({ ...base, ga4: ga4(1200) })
    expect(md).toContain('# Weekly digest')
    expect(md).toContain('2026-07-21 → 2026-07-27')
  })

  it('renders traffic metrics with period-over-period change', () => {
    const md = buildDigestMarkdown({ ...base, ga4: ga4(1200), ga4Previous: ga4(1000) })
    expect(md).toContain('## Website traffic')
    expect(md).toContain('1.2k')
    expect(md).toContain('+20.0%')
  })

  it('renders search totals', () => {
    const md = buildDigestMarkdown({ ...base, gsc: gsc() })
    expect(md).toContain('## Search performance')
    expect(md).toContain('**Clicks:** 100')
    expect(md).toContain('**Average position:** 8.0')
  })

  it('weights average position by impressions', () => {
    // A plain mean would let a one-impression page at position 1 outweigh the
    // rest of the site.
    const md = buildDigestMarkdown({
      ...base,
      gsc: gsc({
        rows: [
          { keys: [], clicks: 0, impressions: 1, ctr: 0, position: 1 },
          { keys: [], clicks: 0, impressions: 999, ctr: 0, position: 20 },
        ],
      }),
    })
    expect(md).toContain('**Average position:** 20.0')
  })

  it('surfaces the anonymization caveat as a quote', () => {
    const md = buildDigestMarkdown({
      ...base,
      gsc: gsc({ anonymizedDataWarning: 'totals under-report' }),
    })
    expect(md).toContain('> totals under-report')
  })

  it('lists top pages when supplied', () => {
    const md = buildDigestMarkdown({
      ...base,
      gscTopPages: {
        dimensions: ['page'],
        rows: [{ keys: ['/pricing'], clicks: 42, impressions: 900, ctr: 4.6, position: 3 }],
      },
    })
    expect(md).toContain('## Top pages by clicks')
    expect(md).toContain('/pricing')
  })

  it('STATES a missing source rather than silently omitting it', () => {
    // A digest that quietly drops Search Console reads as "no search traffic"
    // instead of "we could not reach it".
    const md = buildDigestMarkdown({
      ...base,
      ga4: ga4(10),
      notes: ['Search Console data unavailable: upstream 503'],
    })
    expect(md).toContain('## Notes')
    expect(md).toContain('upstream 503')
  })

  it('explains how to fix an entirely empty digest', () => {
    const md = buildDigestMarkdown(base)
    expect(md).toContain('No analytics data was available')
    expect(md).toContain('Analytics Sources')
  })

  it('produces markdown the Doc converter can format', () => {
    const md = buildDigestMarkdown({ ...base, ga4: ga4(1200), gsc: gsc() })
    expect(md).toMatch(/^# /)
    expect(md).toContain('| Metric | This period | Change |')
    expect(md.trimEnd().endsWith('_Generated automatically by the HUB Overlay._')).toBe(true)
  })
})
