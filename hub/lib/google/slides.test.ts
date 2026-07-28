import { describe, it, expect, vi, afterEach } from 'vitest'
import { createDeckFromSpec } from './slides'
import { normalizeDeckSpec } from './deck-spec'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Mocked Slides + Drive, routed by URL shape. */
function stubSlides(opts: { notesIds?: (string | undefined)[]; failFilingWith?: number } = {}) {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = []

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({ url, method, body })

    // presentations.get for speaker-notes placeholder ids
    if (url.includes('slides.googleapis.com') && method === 'GET') {
      return new Response(
        JSON.stringify({
          slides: (opts.notesIds ?? []).map((id, i) => ({
            objectId: `hub_s${i + 1}`,
            slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: id } } },
          })),
        }),
        { status: 200 },
      )
    }

    if (url.includes('drive/v3/files') && opts.failFilingWith) {
      return new Response('filing failed', { status: opts.failFilingWith })
    }

    if (url.endsWith('/presentations')) {
      // create → always yields one auto-created blank slide
      return new Response(
        JSON.stringify({ presentationId: 'deck-1', slides: [{ objectId: 'auto-blank' }] }),
        { status: 200 },
      )
    }

    return new Response(JSON.stringify({}), { status: 200 })
  })

  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

const twoSlideSpec = normalizeDeckSpec({
  title: 'Q3 Review',
  slides: [
    { layout: 'TITLE', title: 'Q3 Review' },
    { layout: 'TITLE_AND_BODY', title: 'Highlights', bullets: ['Revenue up'] },
  ],
})

describe('createDeckFromSpec', () => {
  it('creates the presentation with the title only', async () => {
    const { calls } = stubSlides()
    await createDeckFromSpec('tok', twoSlideSpec)

    expect(calls[0].url).toBe('https://slides.googleapis.com/v1/presentations')
    // Slides ignores anything beyond the title at create time.
    expect(calls[0].body).toEqual({ title: 'Q3 Review' })
  })

  it('applies compiled batches and deletes the auto-created blank slide', async () => {
    const { calls } = stubSlides()
    await createDeckFromSpec('tok', twoSlideSpec)

    const batch = calls.find(c => c.url.includes(':batchUpdate'))
    const requests = (batch?.body?.requests ?? []) as Record<string, unknown>[]

    expect(requests.some(r => 'createSlide' in r)).toBe(true)
    expect(requests).toContainEqual({ deleteObject: { objectId: 'auto-blank' } })
  })

  it('skips the speaker-notes round trip entirely when no slide has notes', async () => {
    const { calls } = stubSlides()
    await createDeckFromSpec('tok', twoSlideSpec)

    // A GET against the Slides API would be the notes lookup — there should be none.
    expect(calls.filter(c => c.url.includes('slides.googleapis.com') && c.method === 'GET')).toHaveLength(0)
  })

  it('reads notes placeholder ids and writes notes when the deck has them', async () => {
    const spec = normalizeDeckSpec({
      title: 'D',
      slides: [{ title: 'A', speakerNotes: 'Say hello' }],
    })
    const { calls } = stubSlides({ notesIds: ['notes-a'] })

    await createDeckFromSpec('tok', spec)

    const notesGet = calls.find(c => c.url.includes('slides.googleapis.com') && c.method === 'GET')
    expect(notesGet?.url).toContain('speakerNotesObjectId')

    const batches = calls.filter(c => c.url.includes(':batchUpdate'))
    const lastRequests = batches[batches.length - 1].body?.requests as Record<string, unknown>[]
    expect(lastRequests).toContainEqual({ insertText: { objectId: 'notes-a', text: 'Say hello' } })
  })

  it('renames and moves the deck into the workspace folder', async () => {
    const { calls } = stubSlides()
    await createDeckFromSpec('tok', twoSlideSpec, { folderId: 'folder-1', tenantId: 'rxfit' })

    const rename = calls.find(c => c.url.includes('drive/v3/files') && c.method === 'PATCH' && c.body?.name)
    expect(rename?.body?.name).toMatch(/^\d{4}-\d{2}-\d{2} — Q3 Review$/)
    expect(rename?.body?.appProperties).toMatchObject({ hubKind: 'deck' })

    // presentations.create cannot set a parent, so the deck is relocated after.
    const move = calls.find(c => c.url.includes('addParents=folder-1'))
    expect(move).toBeTruthy()
  })

  it('still returns the built deck when filing it fails', async () => {
    // The deck exists and has slides; a rename/move failure is cosmetic and
    // must not discard the work.
    const { calls } = stubSlides({ failFilingWith: 500 })
    const deck = await createDeckFromSpec('tok', twoSlideSpec, { folderId: 'folder-1' })

    expect(deck.presentationId).toBe('deck-1')
    expect(deck.slideCount).toBe(2)
    expect(calls.some(c => c.url.includes(':batchUpdate'))).toBe(true)
  })

  it('returns a usable editor URL and slide count', async () => {
    stubSlides()
    const deck = await createDeckFromSpec('tok', twoSlideSpec)

    expect(deck.presentationUrl).toBe('https://docs.google.com/presentation/d/deck-1/edit')
    expect(deck.slideCount).toBe(2)
  })

  it('sends multiple batchUpdate calls for a large deck', async () => {
    const big = normalizeDeckSpec({
      title: 'Big',
      slides: Array.from({ length: 22 }, (_, i) => ({ title: `Slide ${i + 1}` })),
    })
    const { calls } = stubSlides()

    await createDeckFromSpec('tok', big)

    expect(calls.filter(c => c.url.includes(':batchUpdate')).length).toBeGreaterThan(1)
  })
})
