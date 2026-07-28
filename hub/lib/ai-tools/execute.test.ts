import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  executeToolCall,
  executeToolCalls,
  renderToolOutcomes,
  MAX_TOOL_CALLS_PER_TURN,
  type ToolOutcome,
} from './execute'
import type { ToolContext } from './registry'
import { __clearGA4MetadataCache } from '../google/analytics'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  __clearGA4MetadataCache()
})

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  accessToken: 'tok',
  role: 'staff',
  ga4PropertyId: '123',
  gscSiteUrl: 'https://x.test/',
  today: new Date('2026-07-28T00:00:00Z'),
  ...over,
})

/** GA4 tool calls pre-flight the property metadata before reporting, so the
 *  stub answers that request separately from the report itself. */
function stubFetch(payload: unknown, status = 200) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/metadata')) {
      return new Response(
        JSON.stringify({ dimensions: [{ apiName: 'pagePath' }], metrics: [{ apiName: 'sessions' }] }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify(payload), { status })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const validGa4 = { startDate: '2026-07-01', endDate: '2026-07-28', metrics: ['sessions'] }

describe('executeToolCall — guards', () => {
  it('rejects an unknown tool name without calling anything', async () => {
    const fetchMock = stubFetch({})
    const outcome = await executeToolCall({ name: 'made_up_tool', args: {} }, ctx())

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/Unknown tool/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('re-checks role even though the advertised list was already filtered', async () => {
    // The model's proposed name is untrusted input — filtering the advertised
    // list is a UX affordance, not a security boundary.
    const fetchMock = stubFetch({})
    const outcome = await executeToolCall({ name: 'ga4_run_report', args: validGa4 }, ctx({ role: 'onboarding' }))

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/does not have permission/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('validates arguments BEFORE spending a network call', async () => {
    const fetchMock = stubFetch({})
    const outcome = await executeToolCall(
      { name: 'ga4_run_report', args: { startDate: '2026-07-01' } },
      ctx(),
    )

    expect(outcome.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names the offending argument so the model can correct it', async () => {
    stubFetch({})
    const outcome = await executeToolCall(
      { name: 'ga4_run_report', args: { startDate: '2026-07-01', endDate: '2026-07-28', metrics: [] } },
      ctx(),
    )

    expect(outcome.error).toMatch(/metrics/)
  })

  it('rejects an out-of-range GSC dimension', async () => {
    stubFetch({})
    const outcome = await executeToolCall(
      {
        name: 'gsc_search_analytics',
        args: { startDate: '2026-07-01', endDate: '2026-07-28', dimensions: ['nonsense'] },
      },
      ctx(),
    )
    expect(outcome.ok).toBe(false)
  })
})

describe('executeToolCall — failure handling', () => {
  it('returns an upstream failure rather than throwing', async () => {
    // A failed tool should degrade the answer, not fail the chat turn.
    stubFetch({ error: 'boom' }, 500)

    const outcome = await executeToolCall({ name: 'ga4_run_report', args: validGa4 }, ctx())

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/ga4_run_report failed/)
  })

  it('succeeds on a well-formed call', async () => {
    stubFetch({ metricHeaders: [{ name: 'sessions' }], rows: [] })

    const outcome = await executeToolCall({ name: 'ga4_run_report', args: validGa4 }, ctx())

    expect(outcome.ok).toBe(true)
    expect(outcome.result?.summary).toContain('GA4')
  })
})

describe('executeToolCalls', () => {
  it('caps the number of calls per turn', async () => {
    stubFetch({ rows: [] })
    const calls = Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 4 }, () => ({
      name: 'ga4_run_report',
      args: validGa4,
    }))

    const outcomes = await executeToolCalls(calls, ctx())

    // Each call bills against a per-property quota; a runaway model must not
    // fan out unbounded requests.
    expect(outcomes).toHaveLength(MAX_TOOL_CALLS_PER_TURN)
  })

  it('returns an outcome per call, including failures', async () => {
    stubFetch({ rows: [] })
    const outcomes = await executeToolCalls(
      [
        { name: 'ga4_run_report', args: validGa4 },
        { name: 'nope', args: {} },
      ],
      ctx(),
    )

    expect(outcomes.map(o => o.ok)).toEqual([true, false])
  })

  it('handles an empty call list', async () => {
    expect(await executeToolCalls([], ctx())).toEqual([])
  })
})

describe('renderToolOutcomes', () => {
  it('returns nothing when no tools ran', () => {
    expect(renderToolOutcomes([])).toBe('')
  })

  it('tells the model it may state retrieved figures but not invent them', () => {
    const outcomes: ToolOutcome[] = [
      { name: 'ga4_run_report', ok: true, result: { summary: 'GA4 sessions', fenced: '<untrusted_data>rows</untrusted_data>' } },
    ]

    const rendered = renderToolOutcomes(outcomes)
    expect(rendered).toContain('LIVE DATA RETRIEVED THIS TURN')
    expect(rendered).toContain('Do not invent numbers')
    expect(rendered).toContain('<untrusted_data>')
  })

  it('surfaces a failure as a note so the model can say what it could not check', () => {
    const rendered = renderToolOutcomes([
      { name: 'gsc_search_analytics', ok: false, error: 'upstream 503' },
    ])
    expect(rendered).toContain('did not run')
    expect(rendered).toContain('upstream 503')
  })

  it('points an unconfigured source at the settings that fix it', () => {
    const rendered = renderToolOutcomes([
      {
        name: 'ga4_run_report',
        ok: true,
        result: { summary: 'No Google Analytics property is configured.', fenced: '', note: 'NOT_CONFIGURED' },
      },
    ])
    expect(rendered).toContain('Analytics Sources')
  })
})
