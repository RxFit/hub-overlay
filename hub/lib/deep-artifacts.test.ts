import { describe, it, expect, vi } from 'vitest'

/**
 * lib/deep-artifacts — the PURE half (report → artifact shape). The
 * idempotent ensure path runs against real Postgres in
 * tests/deep-artifacts-db.test.ts; here the db is stubbed so importing the
 * module never touches a connection.
 */
vi.mock('@/lib/db', () => ({ db: {}, withTransaction: vi.fn() }))
vi.mock('@/lib/tool-artifacts', () => ({ embedToolArtifact: vi.fn(async () => true) }))
vi.mock('@/lib/tool-runs', () => ({ getToolRunOwned: vi.fn() }))

import { buildDeepRunArtifact, deepRunArtifactTitle } from './deep-artifacts'

const REPORT = [
  '# Churn drivers',
  '',
  'Price is the driver.',
  '',
  '```json',
  JSON.stringify({
    title: 'Churn drivers',
    summary: 'Price is the driver.',
    sections: [
      { heading: 'Evidence', body: 'Three of four cohorts cite price.' },
      { heading: 'Unknowns', body: 'Support quality is unmeasured.' },
    ],
    sources: [
      { title: 'Cohort export', url: 'https://example.com/cohorts' },
      { title: 'javascript source', url: 'javascript:alert(1)' },
    ],
  }),
  '```',
].join('\n')

const RUN = {
  id: '11111111-1111-4111-8111-111111111111',
  tool: 'deep-research',
  brief: 'Why are customers churning?',
  resultMd: REPORT,
  chatId: 'chat-7',
}

describe('buildDeepRunArtifact', () => {
  it('shapes a parsable report into Summary → sections → Sources with stable ids', () => {
    const data = buildDeepRunArtifact(RUN)
    expect(data.toolId).toBe('deep-research')
    expect(data.title).toBe('Churn drivers')
    expect(data.sections.map(s => [s.id, s.type, s.title])).toEqual([
      [`${RUN.id}-summary`, 'recommendation', 'Summary'],
      [`${RUN.id}-s0`, 'insight', 'Evidence'],
      [`${RUN.id}-s1`, 'insight', 'Unknowns'],
      [`${RUN.id}-sources`, 'generic', 'Sources'],
    ])
    expect(data.sections[0].content).toBe('Price is the driver.')
    // Only http(s) sources survive the report parser — no javascript: links.
    expect(data.sections[3].content).toBe('[1] Cohort export — https://example.com/cohorts')
  })

  it('carries the run identity in metadata — deepRunId is the idempotency key', () => {
    const data = buildDeepRunArtifact(RUN)
    expect(data.metadata).toEqual({ deepRunId: RUN.id, chatId: 'chat-7', brief: RUN.brief })
    expect(buildDeepRunArtifact({ ...RUN, chatId: null }).metadata).toEqual({ deepRunId: RUN.id, brief: RUN.brief })
  })

  it('keeps an unparsable report whole as a single Report section, titled from the brief', () => {
    const raw = '# Just markdown\n\nNo JSON block at all.'
    const data = buildDeepRunArtifact({ ...RUN, resultMd: raw })
    expect(data.title).toBe('Why are customers churning?')
    expect(data.sections).toEqual([{ id: `${RUN.id}-report`, type: 'generic', title: 'Report', content: raw }])
  })

  it('bounds a brief-derived title to 80 chars and never yields an empty title', () => {
    const longBrief = 'x'.repeat(500)
    expect(buildDeepRunArtifact({ ...RUN, brief: longBrief, resultMd: 'plain' }).title).toHaveLength(80)
    expect(buildDeepRunArtifact({ ...RUN, brief: '   ', resultMd: null }).sections[0].content).toBe('')
  })

  it('omits the Sources section when the report cites nothing', () => {
    const noSources = REPORT.replace(/"sources":\[[^\]]*\]/, '"sources":[]')
    const data = buildDeepRunArtifact({ ...RUN, resultMd: noSources })
    expect(data.sections.map(s => s.title)).toEqual(['Summary', 'Evidence', 'Unknowns'])
  })
})

describe('deepRunArtifactTitle', () => {
  it('prefixes the human tool name, matching the manual Save & Close convention', () => {
    const data = buildDeepRunArtifact(RUN)
    expect(deepRunArtifactTitle(RUN, data)).toBe('Deep Research: Churn drivers')
    expect(deepRunArtifactTitle({ tool: 'deep-think' }, { ...data, title: 'Pricing call' })).toBe('Deep Think: Pricing call')
  })

  it('falls back to the raw tool id and "Untitled" for unknown tools / blank titles', () => {
    const data = buildDeepRunArtifact(RUN)
    expect(deepRunArtifactTitle({ tool: 'mystery-tool' }, { ...data, title: '' })).toBe('mystery-tool: Untitled')
  })
})
