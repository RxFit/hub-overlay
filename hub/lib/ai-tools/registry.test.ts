import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  READ_TOOLS,
  getTool,
  toolsFor,
  roleAllows,
  toFunctionDeclarations,
  toAnthropicTools,
  type ToolContext,
} from './registry'
import { __clearGA4MetadataCache } from '../google/analytics'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // The metadata cache is process-wide; clearing it keeps tests independent.
  __clearGA4MetadataCache()
})

/**
 * GA4 tool calls make TWO requests: a metadata pre-flight (which validates the
 * model-supplied metric/dimension names) and then the report. The stub answers
 * each by URL.
 */
function stubFetch(reportPayload: unknown, metadata = GA4_METADATA) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url)
      const body = url.includes('/metadata') ? metadata : reportPayload
      return new Response(JSON.stringify(body), { status: 200 })
    }),
  )
  return calls
}

const GA4_METADATA = {
  dimensions: [{ apiName: 'pagePath' }, { apiName: 'country' }],
  metrics: [{ apiName: 'sessions' }, { apiName: 'totalUsers' }],
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  accessToken: 'tok',
  role: 'staff',
  ga4PropertyId: '123',
  gscSiteUrl: 'https://x.test/',
  today: new Date('2026-07-28T00:00:00Z'),
  ...over,
})

describe('roleAllows', () => {
  it('ranks roles so staff clears staff but not admin', () => {
    expect(roleAllows('staff', 'staff')).toBe(true)
    expect(roleAllows('admin', 'staff')).toBe(true)
    expect(roleAllows('superadmin', 'admin')).toBe(true)
    expect(roleAllows('staff', 'admin')).toBe(false)
  })

  it('denies onboarding and unknown/missing roles', () => {
    expect(roleAllows('onboarding', 'staff')).toBe(false)
    expect(roleAllows(undefined, 'staff')).toBe(false)
    expect(roleAllows('not-a-role', 'staff')).toBe(false)
  })
})

describe('registry shape', () => {
  it('exposes uniquely-named tools', () => {
    const names = READ_TOOLS.map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('derives declarations from the same table as dispatch', () => {
    // The invariant that keeps a tool from being advertised but unrunnable.
    for (const decl of toFunctionDeclarations(READ_TOOLS)) {
      expect(getTool(decl.name as string)).toBeDefined()
    }
  })

  it('emits Anthropic tools with input_schema for provider parity', () => {
    const tools = toAnthropicTools(READ_TOOLS)
    expect(tools[0]).toHaveProperty('input_schema')
    expect(tools).toHaveLength(READ_TOOLS.length)
  })

  it('declares every required argument in its JSON Schema', () => {
    for (const tool of READ_TOOLS) {
      const params = tool.parameters as { required?: string[]; properties?: Record<string, unknown> }
      for (const req of params.required ?? []) {
        expect(params.properties).toHaveProperty(req)
      }
    }
  })
})

describe('toolsFor', () => {
  it('returns the analytics group for staff', () => {
    expect(toolsFor('analytics', 'staff').map(t => t.name)).toEqual([
      'ga4_run_report',
      'gsc_search_analytics',
    ])
  })

  it('returns nothing for the none group', () => {
    expect(toolsFor('none', 'admin')).toEqual([])
  })

  it('filters out tools the role cannot run', () => {
    expect(toolsFor('analytics', 'onboarding')).toEqual([])
  })
})

describe('ga4_run_report', () => {
  it('reports a missing property as a note rather than throwing', async () => {
    const tool = getTool('ga4_run_report')!
    const result = await tool.execute(
      { startDate: '2026-07-01', endDate: '2026-07-28', metrics: ['sessions'] },
      ctx({ ga4PropertyId: undefined }),
    )

    expect(result.note).toBe('NOT_CONFIGURED')
    expect(result.fenced).toBe('')
  })

  it('fences the report payload — dimension values are third-party text', async () => {
    stubFetch({
      dimensionHeaders: [{ name: 'pagePath' }],
      metricHeaders: [{ name: 'sessions' }],
      rows: [{ dimensionValues: [{ value: '/pricing' }], metricValues: [{ value: '120' }] }],
    })

    const tool = getTool('ga4_run_report')!
    const result = await tool.execute(
      { startDate: '2026-07-01', endDate: '2026-07-28', metrics: ['sessions'], dimensions: ['pagePath'] },
      ctx(),
    )

    // Page paths and titles come from whatever the site published.
    expect(result.fenced).toContain('<untrusted_data')
    expect(result.fenced).toContain('/pricing')
    expect(result.rows?.[0]).toEqual(['pagePath', 'sessions'])
  })

  it('rejects a hallucinated metric name against the property metadata', async () => {
    stubFetch({ rows: [] })
    const tool = getTool('ga4_run_report')!

    // Metric names come from the MODEL, so this is exactly the case metadata
    // validation exists for — a correctable error, not an opaque Google 400.
    await expect(
      tool.execute({ startDate: 'a', endDate: 'b', metrics: ['sessionz'] }, ctx()),
    ).rejects.toThrow(/sessionz/)
  })

  it('caches property metadata so repeated questions cost one call each', async () => {
    __clearGA4MetadataCache()
    const calls = stubFetch({ rows: [] })
    const tool = getTool('ga4_run_report')!
    const args = { startDate: 'a', endDate: 'b', metrics: ['sessions'] }

    await tool.execute(args, ctx())
    await tool.execute(args, ctx())

    // First question: metadata + report. Second: report only.
    expect(calls.filter(u => u.includes('/metadata'))).toHaveLength(1)
    expect(calls.filter(u => u.includes(':runReport'))).toHaveLength(2)
  })
})

describe('gsc_search_analytics', () => {
  it('reports a missing site as a note', async () => {
    const tool = getTool('gsc_search_analytics')!
    const result = await tool.execute(
      { startDate: '2026-07-01', endDate: '2026-07-28' },
      ctx({ gscSiteUrl: undefined }),
    )
    expect(result.note).toBe('NOT_CONFIGURED')
  })

  it('carries the anonymization caveat INTO the payload the model reasons over', async () => {
    stubFetch({ rows: [{ keys: ['shoes'], clicks: 5, impressions: 100, ctr: 0.05, position: 3 }] })

    const tool = getTool('gsc_search_analytics')!
    const result = await tool.execute(
      { startDate: '2026-07-01', endDate: '2026-07-28', dimensions: ['query'] },
      ctx(),
    )

    // An answer built on silently under-reported totals is wrong in a way the
    // reader can't detect, so the caveat travels with the data.
    expect(result.fenced).toContain('caveat')
    expect(result.fenced).toContain('under-report')
  })

  it('omits the caveat when no query dimension is requested', async () => {
    stubFetch({ rows: [] })
    const tool = getTool('gsc_search_analytics')!
    const result = await tool.execute(
      { startDate: '2026-07-01', endDate: '2026-07-28', dimensions: ['page'] },
      ctx(),
    )
    expect(result.fenced).not.toContain('caveat')
  })
})

describe('calendar_freebusy', () => {
  it('is registered in the workspace group and reachable by staff', () => {
    // The defect this closes: queryFreeBusy shipped with no consumer at all.
    expect(getTool('calendar_freebusy')).toBeDefined()
    expect(toolsFor('workspace', 'staff').map(t => t.name)).toContain('calendar_freebusy')
  })

  it('reports a clear calendar as a distinct answer, not an error', async () => {
    stubFetch({ calendars: { primary: { busy: [] } } })
    const result = await getTool('calendar_freebusy')!.execute(
      { timeMin: '2026-07-30T00:00:00Z', timeMax: '2026-07-31T00:00:00Z' },
      ctx(),
    )
    expect(result.note).toBe('NO_RESULTS')
    expect(result.summary).toContain('clear')
  })

  it('fences merged busy blocks — they derive from other people’s invitations', async () => {
    stubFetch({
      calendars: {
        primary: { busy: [{ start: '2026-07-30T15:00:00Z', end: '2026-07-30T16:00:00Z' }] },
        work: { busy: [{ start: '2026-07-30T15:30:00Z', end: '2026-07-30T17:00:00Z' }] },
      },
    })

    const result = await getTool('calendar_freebusy')!.execute(
      { timeMin: '2026-07-30T00:00:00Z', timeMax: '2026-07-31T00:00:00Z' },
      ctx(),
    )

    expect(result.fenced).toContain('<untrusted_data')
    // Overlapping blocks across two calendars merge to one busy run.
    expect(JSON.parse(result.fenced.split('\n')[1]).busy).toHaveLength(1)
  })

  it('rejects a call missing the time range before hitting Google', () => {
    const tool = getTool('calendar_freebusy')!
    expect(tool.schema.safeParse({ timeMin: '2026-07-30T00:00:00Z' }).success).toBe(false)
  })
})

describe('list_file_access', () => {
  /**
   * `permissions.list` accepts `drive.readonly`, so the read half of sharing
   * works on ANY file the user can see — including ones the Hub cannot re-share.
   * That is why this lives in the read registry rather than beside the write
   * path: it can answer "who has access?" even where the answer to "give Sam
   * access" would be "I can't".
   */
  it('is registered in the workspace group and reachable by staff', () => {
    expect(getTool('list_file_access')).toBeDefined()
    expect(toolsFor('workspace', 'staff').map(t => t.name)).toContain('list_file_access')
  })

  it('reports no match as a benign note rather than an error', async () => {
    stubFetch({ files: [] })
    const result = await getTool('list_file_access')!.execute({ file: 'nothing' }, ctx())
    expect(result.note).toBe('NO_RESULTS')
  })

  it('prefers an exact name match over the top relevance hit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        // Drive file search → two hits, the exact-name one ranked second.
        if (url.includes('/files?')) {
          return new Response(
            JSON.stringify({
              files: [
                { id: 'loose', name: 'Pricing notes 2026' },
                { id: 'exact', name: 'Pricing' },
              ],
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            permissions: [
              { id: 'p1', type: 'user', role: 'writer', emailAddress: 'maria@acme.com' },
            ],
          }),
          { status: 200 },
        )
      }),
    )

    const result = await getTool('list_file_access')!.execute({ file: 'Pricing' }, ctx())

    expect(result.summary).toContain('"Pricing"')
    // Permission entries carry other people's names and addresses — fenced like
    // every other third-party payload.
    expect(result.fenced).toContain('<untrusted_data')
    const payload = JSON.parse(result.fenced.split('\n')[1])
    expect(payload.file.id).toBe('exact')
    expect(payload.access).toEqual(['maria@acme.com — editor'])
    expect(payload.otherMatches).toEqual(['Pricing notes 2026'])
  })

  it('rejects a call with no file reference before hitting Google', () => {
    expect(getTool('list_file_access')!.schema.safeParse({}).success).toBe(false)
  })
})

describe('ga4_run_report — repair through the real entry (mutation guard)', () => {
  it('repairs a renamed metric, succeeds, and discloses the adjustment in summary + payload', async () => {
    // Property metadata knows keyEvents (current name), not conversions
    // (Google's pre-2024 name). Without { repair: true } wired in execute(),
    // this exact call throws — deleting the option must fail THIS test.
    stubFetch(
      {
        metricHeaders: [{ name: 'keyEvents' }],
        rows: [{ metricValues: [{ value: '42' }] }],
        rowCount: 1,
      },
      {
        dimensions: [{ apiName: 'pagePath' }],
        metrics: [{ apiName: 'sessions' }, { apiName: 'keyEvents' }],
      },
    )

    const tool = getTool('ga4_run_report')!
    const result = await tool.execute(
      { startDate: '2026-07-01', endDate: '2026-07-28', metrics: ['conversions'] },
      ctx(),
    )

    // The summary names the metric the data actually holds, not the one asked for.
    expect(result.summary).toContain('keyEvents')
    expect(result.summary).not.toContain('conversions')
    // The fenced payload discloses the rename so the model can say so.
    expect(result.fenced).toContain('fieldAdjustments')
    expect(result.fenced).toContain('"from":"conversions"')
    expect(result.fenced).toContain('"to":"keyEvents"')
  })
})
