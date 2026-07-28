import { describe, it, expect, vi, afterEach } from 'vitest'
import { looksAnalytical, extractJson, parsePlan, planToolCalls } from './plan'
import { READ_TOOLS } from './registry'

vi.mock('../gemini', () => ({
  geminiGenerateText: vi.fn(),
}))

import { geminiGenerateText } from '../gemini'

afterEach(() => {
  vi.clearAllMocks()
})

describe('looksAnalytical', () => {
  it('matches questions about traffic and search performance', () => {
    expect(looksAnalytical('how did organic traffic do last month?')).toBe(true)
    expect(looksAnalytical('which pages got the most clicks?')).toBe(true)
    expect(looksAnalytical('what is our bounce rate')).toBe(true)
    expect(looksAnalytical('show me GA4 sessions')).toBe(true)
    expect(looksAnalytical('where are we ranking for those keywords')).toBe(true)
  })

  it('does not fire on ordinary workspace questions', () => {
    // These are the overwhelming majority of turns — a match here would add a
    // model round trip to every one of them.
    expect(looksAnalytical("what's on my calendar tomorrow?")).toBe(false)
    expect(looksAnalytical('summarize this email thread')).toBe(false)
    expect(looksAnalytical('create a task to call the vendor')).toBe(false)
    expect(looksAnalytical('make me a slide deck about Q3')).toBe(false)
  })
})

describe('extractJson', () => {
  it('unwraps a fenced code block', () => {
    expect(extractJson('```json\n{"calls":[]}\n```')).toBe('{"calls":[]}')
    expect(extractJson('```\n{"calls":[]}\n```')).toBe('{"calls":[]}')
  })

  it('recovers JSON that follows a prose preamble', () => {
    expect(extractJson('Sure! {"calls":[]}')).toBe('{"calls":[]}')
  })

  it('passes bare JSON through', () => {
    expect(extractJson('{"calls":[]}')).toBe('{"calls":[]}')
  })
})

describe('parsePlan', () => {
  it('extracts well-formed calls', () => {
    const calls = parsePlan('{"calls":[{"name":"ga4_run_report","args":{"metrics":["sessions"]}}]}')
    expect(calls).toEqual([{ name: 'ga4_run_report', args: { metrics: ['sessions'] } }])
  })

  it('defaults missing args to an empty object', () => {
    expect(parsePlan('{"calls":[{"name":"x"}]}')).toEqual([{ name: 'x', args: {} }])
  })

  it('returns nothing for unparseable output instead of throwing', () => {
    // A bad plan must degrade to "answer without live data", never fail the turn.
    expect(parsePlan('I cannot help with that')).toEqual([])
    expect(parsePlan('')).toEqual([])
    expect(parsePlan('{"calls": "not-an-array"}')).toEqual([])
  })

  it('drops entries with no usable name', () => {
    expect(parsePlan('{"calls":[{"args":{}},{"name":42},{"name":"ok"}]}')).toEqual([
      { name: 'ok', args: {} },
    ])
  })
})

describe('planToolCalls', () => {
  const mockGemini = vi.mocked(geminiGenerateText)

  it('skips the model call entirely for non-analytics questions', async () => {
    const calls = await planToolCalls("what's on my calendar?", READ_TOOLS)

    expect(calls).toEqual([])
    expect(mockGemini).not.toHaveBeenCalled()
  })

  it('skips when no tools are available to the caller', async () => {
    const calls = await planToolCalls('how is our traffic?', [])
    expect(calls).toEqual([])
    expect(mockGemini).not.toHaveBeenCalled()
  })

  it('plans calls for an analytics question', async () => {
    mockGemini.mockResolvedValue({
      text: '{"calls":[{"name":"gsc_search_analytics","args":{"startDate":"2026-06-01","endDate":"2026-06-30"}}]}',
      model: 'test',
    })

    const calls = await planToolCalls('how did organic traffic do last month?', READ_TOOLS)

    expect(calls).toEqual([
      { name: 'gsc_search_analytics', args: { startDate: '2026-06-01', endDate: '2026-06-30' } },
    ])
  })

  it('gives the planner the current date so relative ranges resolve', async () => {
    mockGemini.mockResolvedValue({ text: '{"calls":[]}', model: 'test' })

    await planToolCalls('traffic last month?', READ_TOOLS, new Date('2026-07-28T00:00:00Z'))

    const system = mockGemini.mock.calls[0][0]
    expect(system).toContain('2026-07-28')
    // The tool declarations must reach the planner or it cannot name arguments.
    expect(system).toContain('ga4_run_report')
  })

  it('returns no calls when the model is unavailable', async () => {
    mockGemini.mockRejectedValue(new Error('all models cooling down'))

    const calls = await planToolCalls('how is our traffic?', READ_TOOLS)

    expect(calls).toEqual([])
  })
})
