/**
 * DeckSpec — the validated outline a deck is generated from.
 *
 * The model NEVER emits Slides API requests. It emits this outline; the
 * deterministic compiler (slides-compiler.ts) turns it into `batchUpdate`
 * requests. Slides requests are full of object ids, placeholder mappings and
 * text ranges — exactly the kind of index arithmetic language models get subtly
 * wrong, producing decks with overlapping or empty text boxes. Constraining the
 * model to content and letting TypeScript do the mechanics is what makes deck
 * generation reliable rather than occasionally-right.
 *
 * The spec is also the thing the confirm card shows the user *before* anything
 * is created (outline-first), so it has to be readable on its own.
 */

import { z } from 'zod'

/**
 * Supported predefined layouts.
 *
 * Deliberately a conservative subset of Google's `PredefinedLayout` enum: a
 * `createSlide` whose `placeholderIdMappings` names a placeholder the layout
 * does not actually have fails the ENTIRE batch with a 400. Every layout here
 * has a placeholder set we rely on, so the compiler can map confidently.
 * (`CAPTION_ONLY` from the design sketch is omitted for exactly this reason —
 * its placeholder type varies by theme; `TITLE_ONLY` covers the same intent.)
 */
export const DECK_LAYOUTS = [
  'TITLE',
  'TITLE_AND_BODY',
  'TITLE_AND_TWO_COLUMNS',
  'SECTION_HEADER',
  'MAIN_POINT',
  'BIG_NUMBER',
  'TITLE_ONLY',
  'BLANK',
] as const

export type DeckLayout = (typeof DECK_LAYOUTS)[number]

/** Layouts with no BODY placeholder — bullets have nowhere to land. */
export const BODY_LESS_LAYOUTS: ReadonlySet<DeckLayout> = new Set<DeckLayout>([
  'SECTION_HEADER',
  'MAIN_POINT',
  'TITLE_ONLY',
  'BLANK',
])

export const MAX_SLIDES = 30
export const MAX_BULLETS_PER_SLIDE = 7
export const MAX_TITLE_LENGTH = 90
export const MAX_BULLET_LENGTH = 180

export const SlideSpecSchema = z.object({
  layout: z.enum(DECK_LAYOUTS).default('TITLE_AND_BODY'),
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  bullets: z.array(z.string().min(1).max(MAX_BULLET_LENGTH)).max(MAX_BULLETS_PER_SLIDE).optional(),
  /** Second column for TITLE_AND_TWO_COLUMNS; ignored by other layouts. */
  bulletsRight: z.array(z.string().min(1).max(MAX_BULLET_LENGTH)).max(MAX_BULLETS_PER_SLIDE).optional(),
  /** The headline figure for BIG_NUMBER (e.g. "38%"). */
  bigNumber: z.string().max(30).optional(),
  speakerNotes: z.string().max(4000).optional(),
})

export const DeckSpecSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  slides: z.array(SlideSpecSchema).min(1).max(MAX_SLIDES),
})

export type SlideSpec = z.infer<typeof SlideSpecSchema>
export type DeckSpec = z.infer<typeof DeckSpecSchema>

/**
 * Coerce a loosely-shaped outline into something the schema accepts, WITHOUT
 * losing content.
 *
 * Models pick layouts impressionistically — asking for `SECTION_HEADER` and
 * then attaching three bullets to it. Rejecting that would be pedantic, and
 * silently dropping the bullets (the layout has no BODY placeholder) would be
 * worse: the user asked for those words. So a body-less layout carrying bullets
 * is promoted to `TITLE_AND_BODY`, which keeps every bullet and still looks
 * like what was intended.
 *
 * Over-long titles/bullets are truncated rather than rejected for the same
 * reason: a 95-character title should not fail a 20-slide deck.
 */
export function normalizeDeckSpec(input: unknown): DeckSpec {
  const raw = (input ?? {}) as Record<string, unknown>
  const rawSlides = Array.isArray(raw.slides) ? raw.slides : []

  const slides = rawSlides.slice(0, MAX_SLIDES).map(entry => {
    const slide = (entry ?? {}) as Record<string, unknown>

    const bullets = normalizeBullets(slide.bullets)
    const bulletsRight = normalizeBullets(slide.bulletsRight)

    let layout = (DECK_LAYOUTS as readonly string[]).includes(slide.layout as string)
      ? (slide.layout as DeckLayout)
      : 'TITLE_AND_BODY'

    // Keep the words: promote rather than drop.
    if (bullets.length && BODY_LESS_LAYOUTS.has(layout)) layout = 'TITLE_AND_BODY'

    return {
      layout,
      title: String(slide.title ?? '').trim().slice(0, MAX_TITLE_LENGTH) || 'Untitled',
      ...(bullets.length ? { bullets } : {}),
      ...(bulletsRight.length ? { bulletsRight } : {}),
      ...(typeof slide.bigNumber === 'string' && slide.bigNumber.trim()
        ? { bigNumber: slide.bigNumber.trim().slice(0, 30) }
        : {}),
      ...(typeof slide.speakerNotes === 'string' && slide.speakerNotes.trim()
        ? { speakerNotes: slide.speakerNotes.trim().slice(0, 4000) }
        : {}),
    }
  })

  return DeckSpecSchema.parse({
    title: String(raw.title ?? '').trim().slice(0, MAX_TITLE_LENGTH) || 'Untitled deck',
    slides: slides.length ? slides : [{ layout: 'TITLE', title: 'Untitled' }],
  })
}

function normalizeBullets(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(b => String(b ?? '').trim().slice(0, MAX_BULLET_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_BULLETS_PER_SLIDE)
}

/* ══════════════════════════════════════════
   Markdown → DeckSpec
   ══════════════════════════════════════════ */

interface Section {
  heading: string
  lines: string[]
}

/** Strip list markers, heading hashes and surrounding emphasis from a line. */
function cleanLine(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .trim()
}

/**
 * Split free-form markdown into heading-delimited sections. Content appearing
 * before any heading becomes an "Overview" section so nothing is lost.
 */
function splitIntoSections(markdown: string): Section[] {
  const sections: Section[] = []
  let current: Section | null = null

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    if (/^#{1,6}\s+/.test(line)) {
      current = { heading: cleanLine(line) || 'Untitled', lines: [] }
      sections.push(current)
      continue
    }

    const text = cleanLine(line)
    if (!text) continue

    if (!current) {
      current = { heading: 'Overview', lines: [] }
      sections.push(current)
    }
    current.lines.push(text)
  }

  return sections
}

/**
 * Build a deck outline from free-text/markdown content.
 *
 * This is what upgrades the existing chat flow: the interview collects a title
 * and a blob of content, which previously became a title plus ONE slide holding
 * the entire blob. Here, markdown headings become slide boundaries and
 * list/prose lines become bullets, so the same user input yields a real deck.
 *
 * Sections longer than a slide holds are continued onto "(cont.)" slides rather
 * than truncated — dropping the tail of someone's content is never the right
 * answer.
 */
export function deckSpecFromMarkdown(title: string, markdown?: string): DeckSpec {
  const deckTitle = title.trim() || 'Untitled deck'
  const slides: Record<string, unknown>[] = [{ layout: 'TITLE', title: deckTitle }]

  for (const section of splitIntoSections((markdown ?? '').trim())) {
    if (!section.lines.length) {
      // A heading with no content reads as a section divider.
      slides.push({ layout: 'SECTION_HEADER', title: section.heading })
      continue
    }

    for (let i = 0; i < section.lines.length; i += MAX_BULLETS_PER_SLIDE) {
      const chunk = section.lines.slice(i, i + MAX_BULLETS_PER_SLIDE)
      slides.push({
        layout: 'TITLE_AND_BODY',
        title: i === 0 ? section.heading : `${section.heading} (cont.)`,
        bullets: chunk,
      })
    }
  }

  return normalizeDeckSpec({ title: deckTitle, slides })
}
