import { describe, it, expect } from 'vitest'
import { parseDeepReport } from './deep-report'

/**
 * lib/deep-report.ts — the deep lane's report parser (PR C).
 * Locks the contract's failure-tolerance: one trailing fenced json block,
 * strict JSON, and EVERY miss returns null so the panel falls back to
 * rendering the raw markdown — never a half-parsed report.
 */

const GOOD = [
  '# Churn research',
  'Body text with findings.',
  '',
  '```json',
  JSON.stringify({
    title: 'Churn is price-driven',
    summary: 'Most churn follows the March price change.',
    sections: [
      { heading: 'Findings', body: 'Churn doubled [1].' },
      { heading: 'Confidence & gaps', body: 'High on timing; thin on competitor moves.' },
    ],
    sources: [
      { title: 'Billing export', url: 'https://example.com/billing' },
      { title: 'sketchy', url: 'javascript:alert(1)' },
    ],
  }),
  '```',
].join('\n')

describe('parseDeepReport', () => {
  it('parses the trailing block: title, summary, sections, http(s)-only sources, and the markdown before it', () => {
    const r = parseDeepReport(GOOD)
    expect(r?.title).toBe('Churn is price-driven')
    expect(r?.summary).toContain('March price change')
    expect(r?.sections).toHaveLength(2)
    expect(r?.sections[1].heading).toBe('Confidence & gaps')
    // Non-http(s) source URLs are dropped — these render as anchors.
    expect(r?.sources).toHaveLength(1)
    expect(r?.sources[0].url).toBe('https://example.com/billing')
    expect(r?.markdown).toContain('# Churn research')
    expect(r?.markdown).not.toContain('```json')
  })

  it('returns null when the block is missing, malformed, or not at the tail', () => {
    expect(parseDeepReport('just markdown, no block')).toBeNull()
    expect(parseDeepReport('x\n```json\n{not json}\n```')).toBeNull()
    expect(parseDeepReport('x\n```json\n{"title":"t","summary":"s"}\n```\ntrailing chatter')).toBeNull()
    expect(parseDeepReport(null)).toBeNull()
    expect(parseDeepReport('')).toBeNull()
  })

  it('requires title and summary; tolerates missing sections/sources', () => {
    expect(parseDeepReport('```json\n{"title":"t"}\n```')).toBeNull()
    const minimal = parseDeepReport('report\n```json\n{"title":"t","summary":"s"}\n```')
    expect(minimal?.sections).toEqual([])
    expect(minimal?.sources).toEqual([])
  })

  it('skips malformed section entries instead of failing the whole report', () => {
    const r = parseDeepReport(
      'x\n```json\n{"title":"t","summary":"s","sections":[{"heading":"ok","body":"b"},{"heading":""},"junk"]}\n```',
    )
    expect(r?.sections).toEqual([{ heading: 'ok', body: 'b' }])
  })

  it('uses the LAST fenced json block when the report itself contains one', () => {
    const withInner = [
      'Report showing a config example:',
      '```json',
      '{"example": true}',
      '```',
      'More prose.',
      '```json',
      '{"title":"t","summary":"s"}',
      '```',
    ].join('\n')
    const r = parseDeepReport(withInner)
    expect(r?.title).toBe('t')
    expect(r?.markdown).toContain('{"example": true}')
  })
})
