import { describe, it, expect } from 'vitest'
import {
  parseRetrievalPlan,
  buildPlannerPrompt,
  renderRetrievalContext,
  MAX_RETRIEVAL_STEPS,
  MAX_QUERY_LENGTH,
} from './retrieval-planner'

/**
 * The planner's output reaches code that calls Google with the user's token, so
 * parsing is a trust boundary: only tools we implement may survive it, and
 * anything malformed must degrade to "retrieve nothing" rather than throw.
 */

describe('parseRetrievalPlan', () => {
  it('parses a well-formed plan', () => {
    const plan = parseRetrievalPlan(
      '[{"tool":"search_chat","query":"account manager","space":"Nuvita"},{"tool":"search_drive","query":"Nuvita"}]',
    )
    expect(plan).toEqual([
      { tool: 'search_chat', query: 'account manager', space: 'Nuvita' },
      { tool: 'search_drive', query: 'Nuvita' },
    ])
  })

  it('returns [] for an empty plan — the common and correct answer', () => {
    expect(parseRetrievalPlan('[]')).toEqual([])
  })

  it('unwraps a ```json fence the model was told not to add', () => {
    const plan = parseRetrievalPlan('```json\n[{"tool":"search_drive","query":"pricing"}]\n```')
    expect(plan).toEqual([{ tool: 'search_drive', query: 'pricing' }])
  })

  it('recovers a plan embedded in prose', () => {
    const plan = parseRetrievalPlan('Sure! Here you go:\n[{"tool":"search_drive","query":"budget"}]\nHope that helps.')
    expect(plan).toEqual([{ tool: 'search_drive', query: 'budget' }])
  })

  it('DROPS a tool that is not implemented', () => {
    // The trust boundary: a hallucinated tool name must never reach an executor.
    const plan = parseRetrievalPlan(
      '[{"tool":"delete_file","query":"everything"},{"tool":"send_email","query":"x"},{"tool":"search_drive","query":"ok"}]',
    )
    expect(plan).toEqual([{ tool: 'search_drive', query: 'ok' }])
  })

  it('drops entries with a missing or empty query', () => {
    expect(parseRetrievalPlan('[{"tool":"search_drive"},{"tool":"search_chat","query":"   "}]')).toEqual([])
  })

  it('drops entries whose query is not a string', () => {
    expect(parseRetrievalPlan('[{"tool":"search_drive","query":42}]')).toEqual([])
  })

  it('caps the number of steps', () => {
    const many = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({ tool: 'search_drive', query: `q${i}` })),
    )
    expect(parseRetrievalPlan(many)).toHaveLength(MAX_RETRIEVAL_STEPS)
  })

  it('truncates an overlong query instead of passing it through', () => {
    const plan = parseRetrievalPlan(
      JSON.stringify([{ tool: 'search_drive', query: 'x'.repeat(500) }]),
    )
    expect(plan[0].query).toHaveLength(MAX_QUERY_LENGTH)
  })

  it('deduplicates identical lookups (each duplicate is a wasted round-trip)', () => {
    const plan = parseRetrievalPlan(
      '[{"tool":"search_drive","query":"Nuvita"},{"tool":"search_drive","query":"nuvita"}]',
    )
    expect(plan).toHaveLength(1)
  })

  it('treats a differing space as a distinct lookup', () => {
    const plan = parseRetrievalPlan(
      '[{"tool":"search_chat","query":"pricing","space":"A"},{"tool":"search_chat","query":"pricing","space":"B"}]',
    )
    expect(plan).toHaveLength(2)
  })

  it('omits a blank space rather than passing an empty filter', () => {
    const plan = parseRetrievalPlan('[{"tool":"search_chat","query":"x","space":"  "}]')
    expect(plan[0]).toEqual({ tool: 'search_chat', query: 'x' })
    expect(plan[0]).not.toHaveProperty('space')
  })

  it('never throws on garbage — it degrades to no retrieval', () => {
    for (const junk of ['', 'not json at all', '{"tool":"search_drive"}', 'null', '[1,2,3]', '[[]]']) {
      expect(() => parseRetrievalPlan(junk)).not.toThrow()
      expect(parseRetrievalPlan(junk)).toEqual([])
    }
  })

  it('tolerates a non-string input', () => {
    expect(parseRetrievalPlan(undefined as unknown as string)).toEqual([])
  })
})

describe('buildPlannerPrompt', () => {
  it('lists the visible spaces so the planner can target one by name', () => {
    const prompt = buildPlannerPrompt(['Nuvita', 'Corporate Wellness'])
    expect(prompt).toContain('- Nuvita')
    expect(prompt).toContain('- Corporate Wellness')
  })

  it('handles having no spaces without emitting an empty bullet', () => {
    expect(buildPlannerPrompt([])).toContain('(no chat spaces visible)')
  })

  it('names only the read-only tools', () => {
    const prompt = buildPlannerPrompt([])
    expect(prompt).toContain('search_drive')
    expect(prompt).toContain('search_chat')
    // Writes stay behind the confirm-card gate — the planner must not know of them.
    expect(prompt).not.toContain('send_gmail')
    expect(prompt).not.toContain('create_task')
  })

  it('tells the planner that returning nothing is correct', () => {
    expect(buildPlannerPrompt([])).toMatch(/Return \[\] when/)
  })
})

describe('renderRetrievalContext', () => {
  it('returns an empty string when nothing was retrieved', () => {
    expect(renderRetrievalContext([])).toBe('')
  })

  it('instructs the model to cite and NOT to invent', () => {
    const out = renderRetrievalContext(['#### Drive search: "x"\nfound a thing'])
    expect(out).toContain('found a thing')
    expect(out).toMatch(/never guess/i)
    expect(out).toMatch(/cite it|name the file/i)
  })
})
