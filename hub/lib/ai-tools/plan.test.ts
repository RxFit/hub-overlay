import { describe, it, expect, vi, afterEach } from 'vitest'
import { looksAnalytical, looksWorkspaceRelated, extractJson, parsePlan, planToolCalls } from './plan'
import { READ_TOOLS } from './registry'

vi.mock('../gemini', () => ({
  geminiGenerateText: vi.fn(),
}))

vi.mock('../claude', () => ({
  claudeChat: vi.fn(),
  isClaudeConfigured: vi.fn(() => true),
}))

import { geminiGenerateText } from '../gemini'
import { claudeChat, isClaudeConfigured } from '../claude'

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

  it('skips the model call entirely when no tool could answer', async () => {
    // Was "what's on my calendar?" — that now DOES plan, deliberately, since
    // calendar_freebusy can answer availability. Replaced with a message no
    // registered tool could serve, which is what this test is really about.
    const calls = await planToolCalls('write me a poem about Austin', READ_TOOLS)

    expect(calls).toEqual([])
    expect(mockGemini).not.toHaveBeenCalled()
  })

  it('DOES plan for an availability question now that free/busy exists', async () => {
    mockGemini.mockResolvedValue({ text: '{"calls":[]}', model: 'test' })

    await planToolCalls('when am I free Thursday?', READ_TOOLS)

    expect(mockGemini).toHaveBeenCalled()
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

/**
 * Cross-provider failover for PLANNING.
 *
 * The regression this guards: planning ran on Gemini only, so whenever the
 * Gemini chain was down or cooling, every read tool silently vanished. The user
 * saw the assistant answer a Drive/Chat question from a web search and then
 * offer to check Drive and Chat — with the "Primary model unavailable" banner
 * at the top of the same reply. Tools went missing at exactly the moment the
 * banner explained why.
 */
describe('planner provider failover', () => {
  const tools = READ_TOOLS.filter(t => t.group === 'workspace')
  const QUESTION = 'who is our account manager at Nuvita?'
  const PLAN = '{"calls":[{"name":"search_chat","args":{"query":"account manager","space":"Nuvita"}}]}'

  it('falls back to Claude when the Gemini chain is unavailable', async () => {
    vi.mocked(geminiGenerateText).mockRejectedValue(new Error('All Gemini models failed or cooling down'))
    vi.mocked(claudeChat).mockResolvedValue(PLAN)

    const calls = await planToolCalls(QUESTION, tools)

    expect(claudeChat).toHaveBeenCalled()
    expect(calls).toEqual([{ name: 'search_chat', args: { query: 'account manager', space: 'Nuvita' } }])
  })

  it('does not call Claude when Gemini succeeds', async () => {
    vi.mocked(geminiGenerateText).mockResolvedValue({ text: PLAN, model: 'gemini' })

    await planToolCalls(QUESTION, tools)

    expect(claudeChat).not.toHaveBeenCalled()
  })

  it('degrades to no tools — never throws — when BOTH providers fail', async () => {
    vi.mocked(geminiGenerateText).mockRejectedValue(new Error('gemini down'))
    vi.mocked(claudeChat).mockRejectedValue(new Error('claude down'))

    await expect(planToolCalls(QUESTION, tools)).resolves.toEqual([])
  })

  it('skips the fallback when Claude is not configured', async () => {
    vi.mocked(geminiGenerateText).mockRejectedValue(new Error('gemini down'))
    vi.mocked(isClaudeConfigured).mockReturnValue(false)

    await expect(planToolCalls(QUESTION, tools)).resolves.toEqual([])
    expect(claudeChat).not.toHaveBeenCalled()
  })
})

describe('looksWorkspaceRelated — availability questions', () => {
  it('fires on availability phrasing so the freebusy tool is reachable', () => {
    // Registering a tool is not enough: if the prefilter never matches, the
    // group is never offered and the tool stays as dead as it was before.
    expect(looksWorkspaceRelated('when am I free Thursday?')).toBe(true)
    expect(looksWorkspaceRelated('am I available at 3 tomorrow')).toBe(true)
    expect(looksWorkspaceRelated("what's on my schedule Friday")).toBe(true)
    expect(looksWorkspaceRelated('is my calendar booked that afternoon')).toBe(true)
  })

  it('still ignores messages with no workspace or availability signal', () => {
    expect(looksWorkspaceRelated('thanks, that works')).toBe(false)
    expect(looksWorkspaceRelated('write me a poem')).toBe(false)
  })
})
