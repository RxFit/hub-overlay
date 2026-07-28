import { describe, it, expect } from 'vitest'
import {
  compileDeck,
  buildSpeakerNotesRequests,
  deckHasSpeakerNotes,
  slideId,
  SLIDES_PER_BATCH,
} from './slides-compiler'
import { normalizeDeckSpec } from './deck-spec'

/** Flatten every batch into one ordered request list. */
const allRequests = (batches: unknown[][]) => batches.flat() as Record<string, Record<string, unknown>>[]

const find = (requests: Record<string, Record<string, unknown>>[], key: string) =>
  requests.filter(r => key in r)

describe('compileDeck — golden request stream', () => {
  it('emits the exact create+fill sequence for a two-slide deck', () => {
    const spec = normalizeDeckSpec({
      title: 'Q3',
      slides: [
        { layout: 'TITLE', title: 'Q3 Review', bullets: ['Prepared for the board'] },
        { layout: 'TITLE_AND_BODY', title: 'Highlights', bullets: ['Revenue up', 'Churn down'] },
      ],
    })

    const { batches, slideObjectIds } = compileDeck(spec)

    expect(batches).toHaveLength(1)
    expect(slideObjectIds).toEqual(['hub_s1', 'hub_s2'])
    expect(allRequests(batches)).toEqual([
      {
        createSlide: {
          objectId: 'hub_s1',
          slideLayoutReference: { predefinedLayout: 'TITLE' },
          placeholderIdMappings: [
            { layoutPlaceholder: { type: 'CENTERED_TITLE' }, objectId: 'hub_s1_title' },
            { layoutPlaceholder: { type: 'SUBTITLE' }, objectId: 'hub_s1_body' },
          ],
        },
      },
      { insertText: { objectId: 'hub_s1_title', text: 'Q3 Review' } },
      { insertText: { objectId: 'hub_s1_body', text: 'Prepared for the board' } },
      {
        createSlide: {
          objectId: 'hub_s2',
          slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
          placeholderIdMappings: [
            { layoutPlaceholder: { type: 'TITLE' }, objectId: 'hub_s2_title' },
            { layoutPlaceholder: { type: 'BODY' }, objectId: 'hub_s2_body' },
          ],
        },
      },
      { insertText: { objectId: 'hub_s2_title', text: 'Highlights' } },
      { insertText: { objectId: 'hub_s2_body', text: 'Revenue up\nChurn down' } },
      {
        createParagraphBullets: {
          objectId: 'hub_s2_body',
          textRange: { type: 'ALL' },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      },
    ])
  })
})

describe('compileDeck — layouts', () => {
  it('maps two columns to indexed BODY placeholders', () => {
    const spec = normalizeDeckSpec({
      title: 'D',
      slides: [
        {
          layout: 'TITLE_AND_TWO_COLUMNS',
          title: 'Compare',
          bullets: ['left one'],
          bulletsRight: ['right one'],
        },
      ],
    })

    const requests = allRequests(compileDeck(spec).batches)
    const mappings = (requests[0].createSlide as { placeholderIdMappings: unknown[] }).placeholderIdMappings

    expect(mappings).toEqual([
      { layoutPlaceholder: { type: 'TITLE' }, objectId: 'hub_s1_title' },
      { layoutPlaceholder: { type: 'BODY', index: 0 }, objectId: 'hub_s1_body' },
      { layoutPlaceholder: { type: 'BODY', index: 1 }, objectId: 'hub_s1_body2' },
    ])
    expect(find(requests, 'insertText').map(r => r.insertText.text)).toEqual([
      'Compare',
      'left one',
      'right one',
    ])
  })

  it('puts the figure in the title placeholder for BIG_NUMBER and demotes the caption', () => {
    const spec = normalizeDeckSpec({
      title: 'D',
      slides: [{ layout: 'BIG_NUMBER', title: 'Churn reduction', bigNumber: '38%' }],
    })

    const requests = allRequests(compileDeck(spec).batches)
    const inserts = find(requests, 'insertText')

    // The layout renders the TITLE placeholder large — that has to be the number.
    expect(inserts[0].insertText).toMatchObject({ objectId: 'hub_s1_title', text: '38%' })
    expect(inserts[1].insertText).toMatchObject({ objectId: 'hub_s1_body', text: 'Churn reduction' })
  })

  it('maps only a title for body-less layouts', () => {
    const spec = normalizeDeckSpec({ title: 'D', slides: [{ layout: 'MAIN_POINT', title: 'One thing' }] })
    const requests = allRequests(compileDeck(spec).batches)

    const mappings = (requests[0].createSlide as { placeholderIdMappings: unknown[] }).placeholderIdMappings
    expect(mappings).toHaveLength(1)
    expect(find(requests, 'insertText')).toHaveLength(1)
  })

  it('creates a BLANK slide with no placeholder mappings or text', () => {
    const spec = normalizeDeckSpec({ title: 'D', slides: [{ layout: 'BLANK', title: 'ignored' }] })
    const requests = allRequests(compileDeck(spec).batches)

    expect(requests).toHaveLength(1)
    expect(requests[0].createSlide).not.toHaveProperty('placeholderIdMappings')
  })

  it('never emits an empty insertText (Slides rejects it)', () => {
    const spec = normalizeDeckSpec({
      title: 'D',
      slides: [{ layout: 'TITLE', title: 'Just a title' }],
    })

    const inserts = find(allRequests(compileDeck(spec).batches), 'insertText')
    for (const req of inserts) {
      expect(String(req.insertText.text)).not.toBe('')
    }
  })
})

describe('compileDeck — batching and cleanup', () => {
  it('chunks slides so one failed batch does not cost the whole deck', () => {
    const spec = normalizeDeckSpec({
      title: 'Big',
      slides: Array.from({ length: 25 }, (_, i) => ({ title: `Slide ${i + 1}` })),
    })

    const { batches } = compileDeck(spec)
    expect(batches).toHaveLength(Math.ceil(25 / SLIDES_PER_BATCH))
  })

  it('honors a custom chunk size', () => {
    const spec = normalizeDeckSpec({
      title: 'D',
      slides: Array.from({ length: 6 }, (_, i) => ({ title: `S${i}` })),
    })
    expect(compileDeck(spec, { slidesPerBatch: 2 }).batches).toHaveLength(3)
  })

  it('deletes the auto-created blank slide AFTER building our own, in the first batch', () => {
    const spec = normalizeDeckSpec({ title: 'D', slides: [{ title: 'A' }, { title: 'B' }] })
    const { batches } = compileDeck(spec, { deleteSlideIds: ['p'] })

    const first = batches[0] as Record<string, unknown>[]
    // Deleting before creating would briefly empty the deck; deleting in a
    // later batch would leave it visible if that batch failed.
    expect(first[first.length - 1]).toEqual({ deleteObject: { objectId: 'p' } })
    expect(batches).toHaveLength(1)
  })

  it('assigns stable, unique object ids across chunk boundaries', () => {
    const spec = normalizeDeckSpec({
      title: 'D',
      slides: Array.from({ length: 12 }, (_, i) => ({ title: `S${i}` })),
    })

    const { slideObjectIds } = compileDeck(spec)
    expect(new Set(slideObjectIds).size).toBe(12)
    expect(slideObjectIds[11]).toBe(slideId(11))
  })
})

describe('speaker notes', () => {
  const spec = normalizeDeckSpec({
    title: 'D',
    slides: [
      { title: 'A', speakerNotes: 'Say hello' },
      { title: 'B' },
      { title: 'C', speakerNotes: 'Wrap up' },
    ],
  })

  it('detects whether the extra round trip is needed at all', () => {
    expect(deckHasSpeakerNotes(spec)).toBe(true)
    expect(deckHasSpeakerNotes(normalizeDeckSpec({ title: 'D', slides: [{ title: 'A' }] }))).toBe(false)
  })

  it('writes notes only for slides that have them and have a resolved placeholder', () => {
    const requests = buildSpeakerNotesRequests(spec, { 0: 'notes-a', 1: 'notes-b', 2: undefined })

    // Slide B has no notes; slide C has notes but no placeholder id came back.
    expect(requests).toEqual([{ insertText: { objectId: 'notes-a', text: 'Say hello' } }])
  })

  it('returns nothing when no placeholder ids resolved', () => {
    expect(buildSpeakerNotesRequests(spec, {})).toEqual([])
  })
})
