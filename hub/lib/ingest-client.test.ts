import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ingestDocument } from './ingest-client'

/**
 * ingestDocument — chunk a document and push each chunk to the embeddings
 * upsert endpoint (clearing stale chunks for the source first). fetch is
 * mocked; the tests lock the request choreography and the error contract
 * (never throws — always resolves to { success, chunkIds, error? }).
 */

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('PAPERCLIP_API_KEY', 'pk-ingest')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function okJson(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload, text: async () => '' }
}

describe('ingestDocument', () => {
  it('fails fast (no fetch) when PAPERCLIP_API_KEY is missing', async () => {
    vi.stubEnv('PAPERCLIP_API_KEY', '')
    const result = await ingestDocument('rxfit', 'doc://a', 'content')
    expect(result.success).toBe(false)
    expect(result.error).toContain('PAPERCLIP_API_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clears stale chunks first, then upserts every chunk in order', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({})) // DELETE clear
      .mockResolvedValueOnce(okJson({ success: true, id: 'chunk-1' }))
      .mockResolvedValueOnce(okJson({ success: true, id: 'chunk-2' }))

    const para1 = `first ${'a'.repeat(60)}`
    const para2 = `second ${'b'.repeat(60)}`
    const result = await ingestDocument('rxfit', 'doc://notes', `${para1}\n\n${para2}`, {
      baseUrl: 'https://hub.test/',
      chunkSize: 80,
      chunkOverlap: 0,
    })

    expect(result).toEqual({ success: true, chunkIds: ['chunk-1', 'chunk-2'] })

    // 1st call: DELETE with sourceUrl + tenantId, trailing slash stripped from baseUrl.
    const [clearUrl, clearInit] = fetchMock.mock.calls[0]
    expect(clearUrl).toBe(
      'https://hub.test/api/embeddings/upsert?sourceUrl=doc%3A%2F%2Fnotes&tenantId=rxfit',
    )
    expect(clearInit.method).toBe('DELETE')
    expect(clearInit.headers.Authorization).toBe('Bearer pk-ingest')

    // Subsequent calls: POST one body per chunk, in document order.
    const [postUrl, postInit] = fetchMock.mock.calls[1]
    expect(postUrl).toBe('https://hub.test/api/embeddings/upsert')
    expect(postInit.method).toBe('POST')
    const body1 = JSON.parse(postInit.body)
    expect(body1.tenantId).toBe('rxfit')
    expect(body1.sourceUrl).toBe('doc://notes')
    expect(body1.content).toContain('first')
    const body2 = JSON.parse(fetchMock.mock.calls[2][1].body)
    expect(body2.content).toContain('second')
  })

  it('treats a failed clear as a warning and still ingests', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) })
      .mockResolvedValueOnce(okJson({ success: true, id: 'chunk-1' }))

    const result = await ingestDocument('rxfit', 'doc://a', 'short doc')
    expect(result).toEqual({ success: true, chunkIds: ['chunk-1'] })
  })

  it('aborts with a chunk-indexed error when an upsert fails', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({})) // clear
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'bad gateway', json: async () => ({}) })

    const result = await ingestDocument('rxfit', 'doc://a', 'short doc')
    expect(result.success).toBe(false)
    expect(result.chunkIds).toEqual([])
    expect(result.error).toContain('chunk 1')
    expect(result.error).toContain('502')
  })

  it('rejects an upsert response without a chunk id', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({})) // clear
      .mockResolvedValueOnce(okJson({ success: true })) // missing id

    const result = await ingestDocument('rxfit', 'doc://a', 'short doc')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid response for chunk 1')
  })
})
