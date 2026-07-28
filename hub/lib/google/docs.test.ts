import { describe, it, expect, vi, afterEach } from 'vitest'
import { createDocFromMarkdown, stripMarkdownImages, replaceDocMarkdown, GOOGLE_DOC_MIME } from './docs'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stubUpload(response: unknown = { id: 'doc-1', name: '2026-07-28 — Report' }) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(response), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function uploadedBody(fetchMock: ReturnType<typeof stubUpload>): string {
  return fetchMock.mock.calls[0][1]?.body as string
}

/** Pull the metadata JSON back out of the multipart body the upload sent. */
function uploadedMetadata(fetchMock: ReturnType<typeof stubUpload>): Record<string, unknown> {
  const jsonPart = uploadedBody(fetchMock).split('\r\n\r\n')[1].split('\r\n--')[0]
  return JSON.parse(jsonPart)
}

function uploadedContent(fetchMock: ReturnType<typeof stubUpload>): string {
  return uploadedBody(fetchMock).split('\r\n\r\n')[2].split('\r\n--')[0]
}

describe('stripMarkdownImages', () => {
  it('replaces image syntax with its alt text', () => {
    // Remote image URLs the Drive importer cannot fetch become broken
    // placeholders in the finished Doc — keep the words, drop the image.
    expect(stripMarkdownImages('Before ![a chart](https://x.test/c.png) after')).toBe(
      'Before a chart after',
    )
  })

  it('drops the image entirely when there is no alt text', () => {
    expect(stripMarkdownImages('![](https://x.test/c.png)')).toBe('')
  })

  it('leaves ordinary links alone', () => {
    const md = 'See [the docs](https://x.test/docs) for more'
    expect(stripMarkdownImages(md)).toBe(md)
  })

  it('is a no-op on markdown with no images', () => {
    const md = '# Title\n\n- one\n- two'
    expect(stripMarkdownImages(md)).toBe(md)
  })
})

describe('createDocFromMarkdown', () => {
  it('uploads markdown as a Google Doc so Drive performs the conversion', async () => {
    const fetchMock = stubUpload()
    await createDocFromMarkdown('tok', { title: 'Report', markdown: '# Title\n\n**bold**' })

    const url = fetchMock.mock.calls[0][0]
    expect(url).toContain('uploadType=multipart')

    // The conversion happens precisely because the metadata mimeType (Doc)
    // differs from the media content type (markdown).
    expect(uploadedMetadata(fetchMock).mimeType).toBe(GOOGLE_DOC_MIME)
    expect(uploadedBody(fetchMock)).toContain('Content-Type: text/markdown')
    expect(uploadedContent(fetchMock)).toContain('# Title')
  })

  it('files the doc into the workspace folder at creation time', async () => {
    const fetchMock = stubUpload()
    await createDocFromMarkdown('tok', { title: 'Report', markdown: 'x', folderId: 'folder-1' })

    // parents set at create means the file never flickers at Drive root.
    expect(uploadedMetadata(fetchMock).parents).toEqual(['folder-1'])
  })

  it('stamps tenant appProperties for later rediscovery', async () => {
    const fetchMock = stubUpload()
    await createDocFromMarkdown('tok', { title: 'R', markdown: 'x', tenantId: 'rxfit' })

    expect(uploadedMetadata(fetchMock).appProperties).toMatchObject({
      hubOverlay: 'artifact',
      hubTenant: 'rxfit',
      hubKind: 'doc',
    })
  })

  it('date-prefixes the file name by default and skips it when asked', async () => {
    const first = stubUpload()
    await createDocFromMarkdown('tok', { title: 'Report', markdown: 'x' })
    expect(uploadedMetadata(first).name).toMatch(/^\d{4}-\d{2}-\d{2} — Report$/)

    vi.unstubAllGlobals()
    const second = stubUpload()
    await createDocFromMarkdown('tok', { title: 'Report', markdown: 'x', rawFileName: true })
    expect(uploadedMetadata(second).name).toBe('Report')
  })

  it('returns a usable editor URL', async () => {
    stubUpload({ id: 'doc-xyz', name: 'n' })
    const doc = await createDocFromMarkdown('tok', { title: 'R' })
    expect(doc.documentUrl).toBe('https://docs.google.com/document/d/doc-xyz/edit')
    expect(doc.documentId).toBe('doc-xyz')
  })

  it('handles an empty body without sending undefined', async () => {
    const fetchMock = stubUpload()
    await createDocFromMarkdown('tok', { title: 'Empty' })
    expect(uploadedContent(fetchMock)).toBe('')
  })
})

describe('replaceDocMarkdown', () => {
  it('PATCHes the same file id so the link and folder placement survive', async () => {
    const fetchMock = stubUpload({ id: 'doc-1', name: 'n' })
    await replaceDocMarkdown('tok', 'doc-1', '# Revised')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/files/doc-1')
    expect(init?.method).toBe('PATCH')
    expect(uploadedContent(fetchMock)).toContain('# Revised')
  })
})
