import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/* ════════════════════════════════════════════════════════════════════════════
   Provider contract for the ONE embedding request every consumer shares —
   chat RAG over document_chunks (searchSimilarDocuments), ingest
   (upsertDocumentChunk) and the vault corpus (lib/vault/embeddings.ts).

   The installed SDK is @google/generative-ai 0.24, whose embedContent()
   serializes the params object verbatim (JSON.stringify) — so the body on the
   wire is exactly what lib/vector-store passes. Pinned against Google's
   published contract for gemini-embedding-2 (the REST example at
   ai.google.dev/gemini-api/docs/embeddings, 2026-09-22; Google's current SDK,
   @google/genai 2.23, places outputDimensionality at the top level as well):
     POST https://generativelanguage.googleapis.com/v1beta/models/<model>:embedContent
     x-goog-api-key: <key>            (never in the URL)
     { "content": { "parts": [{ "text": … }] }, "outputDimensionality": 768 }
   — outputDimensionality at the TOP level, and NO taskType/title (task_type is
   not supported by gemini-embedding-2). A drift in the SDK, the model id or our
   call site shows up here, offline, instead of as a 400 in production.

   Also pins what a provider 400 looks like AFTER the SDK: a rejection carrying
   `status`, `statusText` and `errorDetails` (google.rpc.ErrorInfo.reason) —
   the fields lib/vault/embeddings.ts reads to name the cause. No network: the
   global fetch is stubbed; no real key: a placeholder is set before first use.
   ════════════════════════════════════════════════════════════════════════════ */

// Runs before the hoisted imports: the placeholder key is what getGenAI() reads
// on first use, and the logger is silenced so the expected 4xx rejections below
// do not print stacks into the CI log.
const { TEST_KEY } = vi.hoisted(() => {
  const TEST_KEY = 'test-gemini-key-not-real'
  process.env.GEMINI_API_KEY = TEST_KEY
  process.env.LOG_LEVEL = 'silent'
  delete process.env.GOOGLE_API_KEY
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
  return { TEST_KEY }
})

import { generateEmbedding, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '@/lib/vector-store'
import { classifyEmbeddingError } from '@/lib/vault/embeddings'

interface Captured { url: string; method: string; headers: Headers; body: unknown }
let captured: Captured[] = []

function jsonResponse(status: number, statusText: string, body: unknown) {
  return new Response(JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } })
}

function stubFetch(answer: () => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const rawBody = init?.body
    captured.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody,
    })
    return answer()
  }))
}

beforeEach(() => { captured = [] })
afterEach(() => { vi.unstubAllGlobals() })

describe('generateEmbedding — wire contract with the Gemini API', () => {
  it('defaults to gemini-embedding-2 at 768 dims unless EMBEDDING_MODEL overrides the id', () => {
    if (!process.env.EMBEDDING_MODEL) expect(EMBEDDING_MODEL).toBe('gemini-embedding-2')
    else expect(EMBEDDING_MODEL).toBe(process.env.EMBEDDING_MODEL)
    expect(EMBEDDING_DIMENSIONS).toBe(768)
  })

  it('POSTs the documented body to v1beta/models/<model>:embedContent with the key in a header', async () => {
    stubFetch(() => jsonResponse(200, 'OK', { embedding: { values: new Array(EMBEDDING_DIMENSIONS).fill(0.5) } }))

    const vector = await generateEmbedding('hello world')

    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS)
    expect(captured).toHaveLength(1)
    const [req] = captured
    expect(req.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`)
    expect(req.url).not.toContain('key=')
    expect(req.method).toBe('POST')
    expect(req.headers.get('x-goog-api-key')).toBe(TEST_KEY)
    expect(req.headers.get('content-type')).toBe('application/json')
    expect(req.body).toEqual({
      content: { parts: [{ text: 'hello world' }] },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    })
  })

  it('sends no taskType, title or nested embedContentConfig — gemini-embedding-2 rejects task_type', async () => {
    stubFetch(() => jsonResponse(200, 'OK', { embedding: { values: [1, 2, 3] } }))
    await generateEmbedding('anything')
    const body = captured[0].body as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['content', 'outputDimensionality'])
    expect(body).not.toHaveProperty('taskType')
    expect(body).not.toHaveProperty('title')
    expect(body).not.toHaveProperty('embedContentConfig')
    expect(body.content).toEqual({ parts: [{ text: 'anything' }] })
  })

  it('truncates the text to the 8000-char input guard before it leaves the process', async () => {
    stubFetch(() => jsonResponse(200, 'OK', { embedding: { values: [0] } }))
    await generateEmbedding('a'.repeat(9_000))
    const body = captured[0].body as { content: { parts: Array<{ text: string }> } }
    expect(body.content.parts[0].text).toHaveLength(8_000)
  })

  it('a provider 400 rejects with status, statusText and the ErrorInfo reason — which the vault classifier turns into `auth`', async () => {
    const providerError = {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com' } }],
      },
    }
    stubFetch(() => jsonResponse(400, 'Bad Request', providerError))

    let thrown: unknown
    try {
      await generateEmbedding('probe')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const fetchErr = thrown as Error & { status?: number; statusText?: string; errorDetails?: unknown[] }
    expect(fetchErr.status).toBe(400)
    expect(fetchErr.statusText).toBe('Bad Request')
    expect(fetchErr.errorDetails?.[0]).toMatchObject({ reason: 'API_KEY_INVALID' })
    expect(fetchErr.message).toContain('[400 Bad Request] API key not valid.')

    const classified = classifyEmbeddingError(thrown)
    expect(classified).toMatchObject({ stage: 'embedding', reason: 'auth', status: 400 })
    expect(classified.message).toBe(`Gemini embedContent (${EMBEDDING_MODEL}) answered HTTP 400 API_KEY_INVALID: API key not valid. Please pass a valid API key.`)
  })

  it('a provider 404 for the model id classifies as `not_found`, so a wrong EMBEDDING_MODEL is named as such', async () => {
    stubFetch(() => jsonResponse(404, 'Not Found', {
      error: { code: 404, message: `models/${EMBEDDING_MODEL} is not found for API version v1beta, or is not supported for embedContent.`, status: 'NOT_FOUND' },
    }))
    await expect(generateEmbedding('probe').catch((err: unknown) => { throw classifyEmbeddingError(err) }))
      .rejects.toMatchObject({ reason: 'not_found', status: 404 })
  })
})
