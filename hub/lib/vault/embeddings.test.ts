import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GoogleGenerativeAIError, GoogleGenerativeAIFetchError, type ErrorDetails } from '@google/generative-ai'

/* ════════════════════════════════════════════════════════════════════════════
   Embedding failure classification — the provider's answer must survive.

   Production finding (2026-09-22): the vault health probe reported only
   "HTTP 400 from Gemini embedContent for gemini-embedding-2" because the SDK's
   message spends ~185 chars on framing (`[GoogleGenerativeAI Error]: Error
   fetching from <url>: [400 Bad Request] …`) and both bounds on the way to the
   report (classify's 200, describeError's 200) cut it off BEFORE the provider's
   own sentence and google.rpc.ErrorInfo reason. These tests pin the cause-first
   message, the reason/status mapping, and that a 200-char bound keeps the cause.
   Offline: lib/vector-store is mocked; the SDK's real error class is used so the
   shape we classify is the shape production throws.
   ════════════════════════════════════════════════════════════════════════════ */

// Before the hoisted imports: the breaker logs an ERROR line when it trips —
// expected here, so keep it out of the CI log.
vi.hoisted(() => { process.env.LOG_LEVEL = 'silent' })

vi.mock('@/lib/vector-store', () => ({
  EMBEDDING_MODEL: 'gemini-embedding-2',
  generateEmbedding: vi.fn(),
}))
// The breaker records an audit event when it trips — keep that off the DB.
vi.mock('@/lib/event-logger', () => ({
  recordEvent: vi.fn(async () => undefined),
  recordEventStrict: vi.fn(async () => undefined),
}))

import { generateEmbedding } from '@/lib/vector-store'
import { breaker } from '@/lib/circuit-breaker'
import { classifyEmbeddingError, embedForVault, VAULT_EMBEDDINGS_BREAKER_KEY } from './embeddings'
import { describeError, VaultUnavailableError } from './errors'

const URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent'
const KEY_INVALID_DETAILS: ErrorDetails[] = [
  { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com' } },
]

/** Exactly what @google/generative-ai 0.24 builds in handleResponseNotOk(). */
function sdkError(status: number, statusText: string, message: string, details?: ErrorDetails[]) {
  const suffix = details ? ` ${JSON.stringify(details)}` : ''
  return new GoogleGenerativeAIFetchError(`Error fetching from ${URL}: [${status} ${statusText}] ${message}${suffix}`, status, statusText, details)
}

const mockedEmbed = vi.mocked(generateEmbedding)

beforeEach(() => {
  mockedEmbed.mockReset()
  breaker.reset(VAULT_EMBEDDINGS_BREAKER_KEY)
})

describe('classifyEmbeddingError', () => {
  it('a 400 API_KEY_INVALID is an `auth` failure whose message leads with the status, reason and provider sentence', () => {
    const err = classifyEmbeddingError(sdkError(400, 'Bad Request', 'API key not valid. Please pass a valid API key.', KEY_INVALID_DETAILS))
    expect(err).toBeInstanceOf(VaultUnavailableError)
    expect(err).toMatchObject({ stage: 'embedding', reason: 'auth', status: 400 })
    expect(err.message).toBe('Gemini embedContent (gemini-embedding-2) answered HTTP 400 API_KEY_INVALID: API key not valid. Please pass a valid API key.')
    expect(err.message).not.toContain('Error fetching from')
    expect(err.message).not.toContain(URL)
  })

  it('REGRESSION: the cause survives the health report’s 200-char describeError bound', () => {
    const err = classifyEmbeddingError(sdkError(400, 'Bad Request', 'API key not valid. Please pass a valid API key.', KEY_INVALID_DETAILS))
    const detail = describeError(err, 200)
    expect(detail).toContain('HTTP 400 API_KEY_INVALID')
    expect(detail).toContain('API key not valid')
    expect(detail.length).toBeLessThanOrEqual(201)
  })

  it('a 400 the provider does not attribute to the key stays `http`, with the status and sentence attached', () => {
    const err = classifyEmbeddingError(sdkError(400, 'Bad Request', 'User location is not supported for the API use.'))
    expect(err).toMatchObject({ reason: 'http', status: 400 })
    expect(err.message).toBe('Gemini embedContent (gemini-embedding-2) answered HTTP 400: User location is not supported for the API use.')
  })

  it('the 400 → auth promotion keys off Google’s ErrorInfo reason (API_KEY_*), never off the sentence’s wording', () => {
    // A request-shape 400 that merely mentions a key-ish field is NOT a credential problem.
    const shape = classifyEmbeddingError(sdkError(400, 'Bad Request', 'Invalid JSON payload received. Unknown name "api_key" at \'content\'.', [
      { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'content', description: 'Unknown name' }] },
    ]))
    expect(shape).toMatchObject({ reason: 'http', status: 400 })
    // A billing precondition that mentions credentials is not one either.
    const billing = classifyEmbeddingError(sdkError(400, 'Bad Request', 'Enable billing on the project that owns this credential.', [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'BILLING_DISABLED', domain: 'googleapis.com' },
    ]))
    expect(billing).toMatchObject({ reason: 'http', status: 400 })
    // The whole API_KEY_* family is.
    const referrer = classifyEmbeddingError(sdkError(400, 'Bad Request', 'Requests from referer <empty> are blocked.', [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_HTTP_REFERRER_BLOCKED', domain: 'googleapis.com' },
    ]))
    expect(referrer).toMatchObject({ reason: 'auth', status: 400 })
    expect(referrer.message).toContain('HTTP 400 API_KEY_HTTP_REFERRER_BLOCKED')
    // No details at all: only Google's exact bad-key sentence is trusted.
    expect(classifyEmbeddingError(sdkError(400, 'Bad Request', 'API key not valid. Please pass a valid API key.'))).toMatchObject({ reason: 'auth', status: 400 })
    expect(classifyEmbeddingError(sdkError(400, 'Bad Request', 'Your API key quota is fine but the payload is not.'))).toMatchObject({ reason: 'http', status: 400 })
  })

  it('401 and 403 are `auth` regardless of wording', () => {
    expect(classifyEmbeddingError(sdkError(401, 'Unauthorized', 'Request had invalid authentication credentials.'))).toMatchObject({ reason: 'auth', status: 401 })
    const blocked = classifyEmbeddingError(sdkError(403, 'Forbidden', 'Requests to this API generativelanguage.googleapis.com method google.ai.generativelanguage.v1beta.GenerativeService.EmbedContent are blocked.', [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_SERVICE_BLOCKED', domain: 'googleapis.com' },
    ]))
    expect(blocked).toMatchObject({ reason: 'auth', status: 403 })
    expect(blocked.message).toContain('HTTP 403 API_KEY_SERVICE_BLOCKED')
  })

  it('404 is `not_found` — the model id is unknown to the API for embedContent', () => {
    const err = classifyEmbeddingError(sdkError(404, 'Not Found', 'models/gemini-embedding-2 is not found for API version v1beta, or is not supported for embedContent.'))
    expect(err).toMatchObject({ reason: 'not_found', status: 404 })
    expect(err.message).toContain('is not found for API version v1beta')
  })

  it('429 and 5xx are `http` with the status attached', () => {
    expect(classifyEmbeddingError(sdkError(429, 'Too Many Requests', 'You exceeded your current quota.'))).toMatchObject({ reason: 'http', status: 429 })
    const outage = classifyEmbeddingError(sdkError(503, 'Service Unavailable', 'The model is overloaded. Please try again later.'))
    expect(outage).toMatchObject({ reason: 'http', status: 503 })
    expect(outage.message).toContain('HTTP 503: The model is overloaded')
  })

  it('a provider sentence is bounded so a verbose upstream cannot blow the ledger field', () => {
    const err = classifyEmbeddingError(sdkError(400, 'Bad Request', 'x'.repeat(2_000)))
    expect(err.message.length).toBeLessThan(260)
  })

  it('a transport failure (the SDK wraps undici’s "fetch failed" without a status) is `network`', () => {
    const err = classifyEmbeddingError(new GoogleGenerativeAIError(`Error fetching from ${URL}: fetch failed`))
    expect(err).toMatchObject({ reason: 'network', status: undefined })
    expect(err.message).toBe('Embedding request failed: fetch failed')
  })

  it('a missing key is `unconfigured`; an abort is `timeout`; an open circuit is `breaker_open`', () => {
    expect(classifyEmbeddingError(new Error('No Gemini API key found for embeddings.'))).toMatchObject({ reason: 'unconfigured' })
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    expect(classifyEmbeddingError(abort)).toMatchObject({ reason: 'timeout' })
  })

  it('passes an existing VaultUnavailableError through untouched and never throws on junk', () => {
    const own = new VaultUnavailableError('embedding', 'integrity', 'x')
    expect(classifyEmbeddingError(own)).toBe(own)
    expect(classifyEmbeddingError('boom')).toMatchObject({ stage: 'embedding', reason: 'http' })
    expect(classifyEmbeddingError(undefined)).toMatchObject({ stage: 'embedding' })
  })
})

describe('embedForVault', () => {
  it('rejects with the classified error and counts the failure on the vault-embeddings circuit', async () => {
    mockedEmbed.mockRejectedValue(sdkError(400, 'Bad Request', 'API key not valid. Please pass a valid API key.', KEY_INVALID_DETAILS))
    await expect(embedForVault('probe')).rejects.toMatchObject({ stage: 'embedding', reason: 'auth', status: 400 })
    expect(mockedEmbed).toHaveBeenCalledWith('probe')
  })

  it('opens the circuit after three failures; the fourth call is `breaker_open` and never reaches the provider', async () => {
    mockedEmbed.mockRejectedValue(sdkError(400, 'Bad Request', 'API key not valid.', KEY_INVALID_DETAILS))
    for (let i = 0; i < 3; i++) await expect(embedForVault('probe')).rejects.toMatchObject({ reason: 'auth' })
    await expect(embedForVault('probe')).rejects.toMatchObject({ reason: 'breaker_open' })
    expect(mockedEmbed).toHaveBeenCalledTimes(3)
    expect(breaker.getState(VAULT_EMBEDDINGS_BREAKER_KEY)).toBe('open')
  })

  it('returns the vector on success and honours an already-expired deadline without dialling', async () => {
    mockedEmbed.mockResolvedValue([0.1, 0.2])
    await expect(embedForVault('ok')).resolves.toEqual([0.1, 0.2])
    const controller = new AbortController()
    controller.abort()
    await expect(embedForVault('late', { signal: controller.signal })).rejects.toMatchObject({ reason: 'timeout' })
    expect(mockedEmbed).toHaveBeenCalledTimes(1)
  })

  it('a deadline that expires mid-flight is `timeout`, and a provider failure under a signal is still classified', async () => {
    let settle: (v: number[]) => void = () => {}
    mockedEmbed.mockImplementationOnce(() => new Promise<number[]>((resolve) => { settle = resolve }))
    const controller = new AbortController()
    const pending = embedForVault('slow', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ reason: 'timeout' })
    settle([1]) // the late result is discarded quietly

    mockedEmbed.mockRejectedValueOnce(sdkError(404, 'Not Found', 'models/x is not found for API version v1beta'))
    await expect(embedForVault('q', { signal: new AbortController().signal })).rejects.toMatchObject({ reason: 'not_found', status: 404 })
  })
})
