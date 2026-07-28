import { describe, it, expect } from 'vitest'
import {
  normalizeDeckSpec,
  deckSpecFromMarkdown,
  DeckSpecSchema,
  MAX_SLIDES,
  MAX_BULLETS_PER_SLIDE,
  MAX_TITLE_LENGTH,
} from './deck-spec'

describe('normalizeDeckSpec', () => {
  it('accepts a well-formed outline unchanged', () => {
    const spec = normalizeDeckSpec({
      title: 'Q3 Review',
      slides: [
        { layout: 'TITLE', title: 'Q3 Review' },
        { layout: 'TITLE_AND_BODY', title: 'Highlights', bullets: ['Revenue up', 'Churn down'] },
      ],
    })

    expect(spec.title).toBe('Q3 Review')
    expect(spec.slides).toHaveLength(2)
    expect(spec.slides[1].bullets).toEqual(['Revenue up', 'Churn down'])
  })

  it('promotes a body-less layout carrying bullets instead of dropping the words', () => {
    // A model asking for SECTION_HEADER and attaching bullets is common. The
    // layout has no BODY placeholder, so keeping the layout would silently lose
    // content the user asked for.
    const spec = normalizeDeckSpec({
      title: 'D',
      slides: [{ layout: 'SECTION_HEADER', title: 'Part Two', bullets: ['a', 'b'] }],
    })

    expect(spec.slides[0].layout).toBe('TITLE_AND_BODY')
    expect(spec.slides[0].bullets).toEqual(['a', 'b'])
  })

  it('leaves a body-less layout alone when it has no bullets', () => {
    const spec = normalizeDeckSpec({
      title: 'D',
      slides: [{ layout: 'SECTION_HEADER', title: 'Part Two' }],
    })
    expect(spec.slides[0].layout).toBe('SECTION_HEADER')
  })

  it('falls back to TITLE_AND_BODY for an unknown layout', () => {
    const spec = normalizeDeckSpec({
      title: 'D',
      slides: [{ layout: 'FANCY_LAYOUT', title: 'x' }],
    })
    expect(spec.slides[0].layout).toBe('TITLE_AND_BODY')
  })

  it('truncates rather than rejects an over-long title', () => {
    const long = 'x'.repeat(MAX_TITLE_LENGTH + 40)
    const spec = normalizeDeckSpec({ title: long, slides: [{ title: long }] })

    expect(spec.title).toHaveLength(MAX_TITLE_LENGTH)
    expect(spec.slides[0].title).toHaveLength(MAX_TITLE_LENGTH)
  })

  it('caps slide and bullet counts', () => {
    const spec = normalizeDeckSpec({
      title: 'D',
      slides: Array.from({ length: MAX_SLIDES + 10 }, (_, i) => ({
        title: `S${i}`,
        bullets: Array.from({ length: MAX_BULLETS_PER_SLIDE + 5 }, (_, b) => `b${b}`),
      })),
    })

    expect(spec.slides).toHaveLength(MAX_SLIDES)
    expect(spec.slides[0].bullets).toHaveLength(MAX_BULLETS_PER_SLIDE)
  })

  it('drops empty bullets and blank entries', () => {
    const spec = normalizeDeckSpec({
      title: 'D',
      slides: [{ title: 'x', bullets: ['keep', '', '   ', null] }],
    })
    expect(spec.slides[0].bullets).toEqual(['keep'])
  })

  it('survives a spec with no slides at all', () => {
    const spec = normalizeDeckSpec({ title: 'Empty' })
    expect(spec.slides).toHaveLength(1)
    expect(() => DeckSpecSchema.parse(spec)).not.toThrow()
  })

  it('substitutes a placeholder title rather than failing on a missing one', () => {
    const spec = normalizeDeckSpec({ slides: [{ bullets: ['a'] }] })
    expect(spec.title).toBeTruthy()
    expect(spec.slides[0].title).toBe('Untitled')
  })

  it('always produces a schema-valid spec', () => {
    const junk = normalizeDeckSpec({ title: 42, slides: [{ layout: 7, title: {}, bullets: 'nope' }] })
    expect(() => DeckSpecSchema.parse(junk)).not.toThrow()
  })
})

describe('deckSpecFromMarkdown', () => {
  it('turns headings into slides and list items into bullets', () => {
    const spec = deckSpecFromMarkdown(
      'Q3 Review',
      ['## Highlights', '- Revenue up 12%', '- Churn down', '', '## Risks', '- Hiring lag'].join('\n'),
    )

    expect(spec.slides.map(s => s.title)).toEqual(['Q3 Review', 'Highlights', 'Risks'])
    expect(spec.slides[0].layout).toBe('TITLE')
    expect(spec.slides[1].bullets).toEqual(['Revenue up 12%', 'Churn down'])
    expect(spec.slides[2].bullets).toEqual(['Hiring lag'])
  })

  it('produces a title-only deck when there is no content', () => {
    const spec = deckSpecFromMarkdown('Just a title', '')
    expect(spec.slides).toHaveLength(1)
    expect(spec.slides[0].layout).toBe('TITLE')
  })

  it('collects pre-heading content under an Overview slide rather than losing it', () => {
    const spec = deckSpecFromMarkdown('D', 'An opening thought\n\n## Details\n- one')
    expect(spec.slides[1]).toMatchObject({ title: 'Overview', bullets: ['An opening thought'] })
  })

  it('handles plain text with no markdown structure', () => {
    const spec = deckSpecFromMarkdown('D', 'First point\nSecond point')
    expect(spec.slides[1].bullets).toEqual(['First point', 'Second point'])
  })

  it('continues a long section onto (cont.) slides instead of truncating', () => {
    const lines = Array.from({ length: MAX_BULLETS_PER_SLIDE + 3 }, (_, i) => `- point ${i + 1}`)
    const spec = deckSpecFromMarkdown('D', ['## Many', ...lines].join('\n'))

    const contentSlides = spec.slides.slice(1)
    expect(contentSlides).toHaveLength(2)
    expect(contentSlides[1].title).toBe('Many (cont.)')
    // Every point survives the split.
    const allBullets = contentSlides.flatMap(s => s.bullets ?? [])
    expect(allBullets).toHaveLength(MAX_BULLETS_PER_SLIDE + 3)
  })

  it('renders a content-free heading as a section divider', () => {
    const spec = deckSpecFromMarkdown('D', '## Part Two')
    expect(spec.slides[1]).toMatchObject({ layout: 'SECTION_HEADER', title: 'Part Two' })
  })

  it('strips markdown emphasis and numbering from bullet text', () => {
    const spec = deckSpecFromMarkdown('D', '## S\n1. **Bold point**\n> quoted line')
    expect(spec.slides[1].bullets).toEqual(['Bold point', 'quoted line'])
  })
})
