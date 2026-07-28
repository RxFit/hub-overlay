/**
 * DeckSpec → Slides `batchUpdate` requests. Pure, deterministic, no network.
 *
 * Everything here is a function of the spec alone, which is what makes deck
 * generation testable: the golden-file suite asserts the exact request stream
 * for a known outline, so a regression shows up as a diff rather than as a
 * subtly broken deck nobody notices until a client meeting.
 *
 * ── Why placeholderIdMappings ──
 * `createSlide` can hand us OUR OWN object ids for the layout's placeholders.
 * Without that we would have to create the slide, read the presentation back to
 * discover the generated placeholder ids, then write the text — three round
 * trips per slide. With it, create-and-fill ride the same batch, which is also
 * Google's documented performance guidance.
 *
 * ── Why the batches are chunked ──
 * A `batchUpdate` is atomic: one bad request fails all of them. Chunking by
 * ~10 slides means a failure costs one chunk, and the already-applied chunks
 * stay applied — so a retry resumes rather than restarting a 30-slide deck.
 */

import { BODY_LESS_LAYOUTS, type DeckSpec, type DeckLayout, type SlideSpec } from './deck-spec'

/** Slides object ids must be 5–50 chars of [a-zA-Z0-9_-]; these are generated,
 *  never user-supplied, so a stable prefix + index is enough. */
const ID_PREFIX = 'hub'

export const SLIDES_PER_BATCH = 10

export interface CompiledDeck {
  /** One request array per `batchUpdate` call, in order. */
  batches: unknown[][]
  /** Slide object ids, index-aligned with `spec.slides`. */
  slideObjectIds: string[]
}

export const slideId = (index: number) => `${ID_PREFIX}_s${index + 1}`
const titleId = (index: number) => `${slideId(index)}_title`
const bodyId = (index: number) => `${slideId(index)}_body`
const bodyRightId = (index: number) => `${slideId(index)}_body2`

interface PlaceholderMapping {
  layoutPlaceholder: { type: string; index?: number }
  objectId: string
}

/**
 * Placeholders each supported layout exposes, and the ids we claim for them.
 *
 * Naming a placeholder the layout lacks fails the whole batch, so this table is
 * deliberately conservative — see the layout subset note in deck-spec.ts.
 */
function placeholderMappings(layout: DeckLayout, index: number): PlaceholderMapping[] {
  switch (layout) {
    case 'TITLE':
      return [
        { layoutPlaceholder: { type: 'CENTERED_TITLE' }, objectId: titleId(index) },
        { layoutPlaceholder: { type: 'SUBTITLE' }, objectId: bodyId(index) },
      ]
    case 'TITLE_AND_BODY':
    case 'BIG_NUMBER':
      return [
        { layoutPlaceholder: { type: 'TITLE' }, objectId: titleId(index) },
        { layoutPlaceholder: { type: 'BODY' }, objectId: bodyId(index) },
      ]
    case 'TITLE_AND_TWO_COLUMNS':
      return [
        { layoutPlaceholder: { type: 'TITLE' }, objectId: titleId(index) },
        { layoutPlaceholder: { type: 'BODY', index: 0 }, objectId: bodyId(index) },
        { layoutPlaceholder: { type: 'BODY', index: 1 }, objectId: bodyRightId(index) },
      ]
    case 'SECTION_HEADER':
    case 'MAIN_POINT':
    case 'TITLE_ONLY':
      return [{ layoutPlaceholder: { type: 'TITLE' }, objectId: titleId(index) }]
    case 'BLANK':
      return []
  }
}

/** Insert text only when there is text — an empty `insertText` is a 400. */
function insertText(objectId: string, text: string): unknown[] {
  const trimmed = text.trim()
  return trimmed ? [{ insertText: { objectId, text: trimmed } }] : []
}

/**
 * Bullets become one text insert (newline-separated) plus a
 * `createParagraphBullets` over the whole range — the documented way to get
 * real bullet formatting rather than lines that merely start with "-".
 */
function bulletRequests(objectId: string, bullets: string[]): unknown[] {
  const clean = bullets.map(b => b.trim()).filter(Boolean)
  if (!clean.length) return []
  return [
    { insertText: { objectId, text: clean.join('\n') } },
    {
      createParagraphBullets: {
        objectId,
        textRange: { type: 'ALL' },
        bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
      },
    },
  ]
}

/** Requests that build one slide: create it, then fill its placeholders. */
function slideRequests(slide: SlideSpec, index: number): unknown[] {
  const mappings = placeholderMappings(slide.layout, index)

  const requests: unknown[] = [
    {
      createSlide: {
        objectId: slideId(index),
        slideLayoutReference: { predefinedLayout: slide.layout },
        ...(mappings.length ? { placeholderIdMappings: mappings } : {}),
      },
    },
  ]

  if (slide.layout === 'BLANK') return requests

  // BIG_NUMBER puts the figure in the title placeholder (that is what the
  // layout renders large) and demotes the slide's own title into the body,
  // where it reads as the caption for the number.
  if (slide.layout === 'BIG_NUMBER') {
    requests.push(...insertText(titleId(index), slide.bigNumber ?? slide.title))
    const bodyLines = [slide.bigNumber ? slide.title : '', ...(slide.bullets ?? [])].filter(Boolean)
    requests.push(...bulletRequests(bodyId(index), bodyLines))
    return requests
  }

  requests.push(...insertText(titleId(index), slide.title))

  if (BODY_LESS_LAYOUTS.has(slide.layout)) return requests

  if (slide.layout === 'TITLE') {
    // The TITLE layout's second placeholder is a subtitle, not a bullet list —
    // bulleting a subtitle looks wrong, so it takes plain joined text.
    requests.push(...insertText(bodyId(index), (slide.bullets ?? []).join(' · ')))
    return requests
  }

  requests.push(...bulletRequests(bodyId(index), slide.bullets ?? []))

  if (slide.layout === 'TITLE_AND_TWO_COLUMNS') {
    requests.push(...bulletRequests(bodyRightId(index), slide.bulletsRight ?? []))
  }

  return requests
}

export interface CompileOptions {
  /** Slide ids to delete first — normally the single blank slide that
   *  `presentations.create` always generates. */
  deleteSlideIds?: string[]
  slidesPerBatch?: number
}

/**
 * Compile a validated DeckSpec into ordered `batchUpdate` request arrays.
 */
export function compileDeck(spec: DeckSpec, opts: CompileOptions = {}): CompiledDeck {
  const perBatch = Math.max(1, opts.slidesPerBatch ?? SLIDES_PER_BATCH)
  const batches: unknown[][] = []

  for (let start = 0; start < spec.slides.length; start += perBatch) {
    const chunk = spec.slides.slice(start, start + perBatch)
    const requests = chunk.flatMap((slide, offset) => slideRequests(slide, start + offset))
    if (requests.length) batches.push(requests)
  }

  // Drop the auto-created blank slide in the FIRST batch, after our own slides
  // are created — deleting it in a later batch would leave it visible if a
  // subsequent batch failed, and deleting before creating would briefly empty
  // the deck.
  const toDelete = opts.deleteSlideIds ?? []
  if (toDelete.length && batches.length) {
    batches[0].push(...toDelete.map(objectId => ({ deleteObject: { objectId } })))
  }

  return {
    batches,
    slideObjectIds: spec.slides.map((_, i) => slideId(i)),
  }
}

/**
 * Requests that write speaker notes, given the notes placeholder id Google
 * assigned to each slide.
 *
 * Notes live on a separate notes page whose placeholder id is NOT knowable at
 * create time (`placeholderIdMappings` covers the slide's own layout
 * placeholders only), so this is a second pass after reading the presentation
 * back. Slides without notes cost nothing.
 */
export function buildSpeakerNotesRequests(
  spec: DeckSpec,
  notesObjectIdBySlideIndex: Record<number, string | undefined>,
): unknown[] {
  return spec.slides.flatMap((slide, index) => {
    const notes = slide.speakerNotes?.trim()
    const objectId = notesObjectIdBySlideIndex[index]
    if (!notes || !objectId) return []
    return [{ insertText: { objectId, text: notes } }]
  })
}

/** True when any slide carries speaker notes — lets callers skip the extra
 *  presentations.get round trip entirely for decks without them. */
export function deckHasSpeakerNotes(spec: DeckSpec): boolean {
  return spec.slides.some(s => !!s.speakerNotes?.trim())
}
