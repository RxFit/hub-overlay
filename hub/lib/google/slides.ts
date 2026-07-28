/**
 * Google Slides artifacts — the "make me a deck from chat" path.
 *
 * What shipped before was a title and, at most, one slide holding an
 * undifferentiated blob of body text. This module builds a real multi-slide
 * deck from a validated outline, using the deterministic compiler
 * (slides-compiler.ts) so no API request shape is ever guessed by a model.
 *
 * Call sequence:
 *   1. presentations.create           — title only; Slides ignores anything else
 *   2. batchUpdate × N                — chunked slide creation + text
 *   3. presentations.get + batchUpdate — speaker notes, only if the deck has any
 *   4. Drive files.update             — move into the Hub workspace folder
 *
 * Step 4 exists because `presentations.create` cannot accept a parent folder;
 * the deck is born at Drive root and relocated immediately after. (Docs and
 * Sheets avoid this by being created through Drive itself.)
 */

import { googleFetch } from './client'
import { moveFileToFolder, artifactFileName, artifactAppProperties } from './drive-workspace'
import { compileDeck, buildSpeakerNotesRequests, deckHasSpeakerNotes } from './slides-compiler'
import type { DeckSpec } from './deck-spec'

const SLIDES_BASE = 'https://slides.googleapis.com/v1/presentations'
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'

export interface DeckArtifact {
  presentationId: string
  title: string
  presentationUrl: string
  slideCount: number
  folderId?: string
}

interface CreatedPresentation {
  presentationId: string
  title?: string
  slides?: { objectId?: string }[]
}

interface PresentationNotes {
  slides?: {
    objectId?: string
    slideProperties?: {
      notesPage?: { notesProperties?: { speakerNotesObjectId?: string } }
    }
  }[]
}

/**
 * Read back the per-slide speaker-notes placeholder ids.
 *
 * These cannot be assigned up front: `placeholderIdMappings` only covers the
 * slide's own layout placeholders, while notes live on a separate notes page
 * whose placeholder Google names itself. Hence one extra read, and only when
 * the deck actually has notes.
 *
 * Returns a map keyed by the slide's position, matching DeckSpec order — the
 * compiler creates slides in spec order, and the auto-created blank slide has
 * been deleted by then, so position is a faithful index.
 */
async function fetchSpeakerNotesIds(
  accessToken: string,
  presentationId: string,
): Promise<Record<number, string | undefined>> {
  const fields = 'slides(objectId,slideProperties(notesPage(notesProperties(speakerNotesObjectId))))'
  const data = await googleFetch<PresentationNotes>(
    `${SLIDES_BASE}/${presentationId}?fields=${encodeURIComponent(fields)}`,
    accessToken,
  )

  const map: Record<number, string | undefined> = {}
  ;(data.slides ?? []).forEach((slide, index) => {
    map[index] = slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId
  })
  return map
}

/** Apply one compiled batch. */
async function runBatch(accessToken: string, presentationId: string, requests: unknown[]): Promise<void> {
  if (!requests.length) return
  await googleFetch<unknown>(`${SLIDES_BASE}/${presentationId}:batchUpdate`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  })
}

/**
 * Build a full deck from a validated DeckSpec.
 *
 * Partial-failure posture: if a later batch fails, the presentation still
 * exists with the slides applied so far and the error propagates. That is
 * deliberately better than discarding a mostly-built deck — the user gets a
 * real link and can retry, rather than losing the work entirely.
 */
export async function createDeckFromSpec(
  accessToken: string,
  spec: DeckSpec,
  opts: { folderId?: string; tenantId?: string; rawFileName?: boolean } = {},
): Promise<DeckArtifact> {
  const created = await googleFetch<CreatedPresentation>(SLIDES_BASE, accessToken, {
    method: 'POST',
    body: JSON.stringify({ title: spec.title }),
  })

  const presentationId = created.presentationId

  // presentations.create always yields one blank slide; the compiler removes it
  // in the first batch so it never shows up in the finished deck.
  const defaultSlideIds = (created.slides ?? [])
    .map(s => s.objectId)
    .filter((id): id is string => !!id)

  const { batches } = compileDeck(spec, { deleteSlideIds: defaultSlideIds })
  for (const requests of batches) {
    await runBatch(accessToken, presentationId, requests)
  }

  if (deckHasSpeakerNotes(spec)) {
    const notesIds = await fetchSpeakerNotesIds(accessToken, presentationId)
    await runBatch(accessToken, presentationId, buildSpeakerNotesRequests(spec, notesIds))
  }

  // Name + file the deck. Both are cosmetic relative to "the deck exists", so
  // neither failure is allowed to discard a successfully built presentation.
  const name = opts.rawFileName ? spec.title : artifactFileName(spec.title)
  try {
    await googleFetch<unknown>(`${DRIVE_FILES}/${presentationId}?fields=id`, accessToken, {
      method: 'PATCH',
      body: JSON.stringify({
        name,
        ...(opts.tenantId ? { appProperties: artifactAppProperties(opts.tenantId, 'deck') } : {}),
      }),
    })
    if (opts.folderId) await moveFileToFolder(accessToken, presentationId, opts.folderId)
  } catch (err) {
    console.warn('[slides] deck built but filing/renaming failed:', err)
  }

  return {
    presentationId,
    title: name,
    presentationUrl: `https://docs.google.com/presentation/d/${presentationId}/edit`,
    slideCount: spec.slides.length,
    folderId: opts.folderId,
  }
}
