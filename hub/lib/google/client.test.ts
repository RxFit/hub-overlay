import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  computeBackoffDelayMs,
  isRetryableStatus,
  buildMultipartBody,
  googleFetch,
  driveMultipartUpload,
} from './client'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Queue of responses the stubbed fetch hands out, in order. */
function stubResponses(responses: Response[]) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.shift()
    if (!next) throw new Error('fetch called more times than the test queued')
    return next
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers })

describe('isRetryableStatus', () => {
  it('retries 429 and 5xx', () => {
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(503)).toBe(true)
  })

  it('does NOT retry a 403 permission/scope denial', () => {
    // The critical case: retrying an insufficient-scope 403 delays the
    // MISSING_SCOPE re-consent prompt and can never succeed.
    const body = JSON.stringify({
      error: { code: 403, message: 'Request had insufficient authentication scopes.' },
    })
    expect(isRetryableStatus(403, body)).toBe(false)
  })

  it('DOES retry a 403 that names a rate/quota reason', () => {
    const body = JSON.stringify({
      error: { errors: [{ reason: 'rateLimitExceeded' }], message: 'Rate Limit Exceeded' },
    })
    expect(isRetryableStatus(403, body)).toBe(true)
    expect(isRetryableStatus(403, 'userRateLimitExceeded')).toBe(true)
    expect(isRetryableStatus(403, 'Quota exceeded for quota metric')).toBe(true)
  })

  it('does not retry ordinary 4xx', () => {
    expect(isRetryableStatus(400)).toBe(false)
    expect(isRetryableStatus(404)).toBe(false)
  })
})

describe('computeBackoffDelayMs', () => {
  const maxJitter = () => 1

  it('grows exponentially from the base delay', () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 10_000 }
    expect(computeBackoffDelayMs(0, null, policy, maxJitter)).toBe(100)
    expect(computeBackoffDelayMs(1, null, policy, maxJitter)).toBe(200)
    expect(computeBackoffDelayMs(2, null, policy, maxJitter)).toBe(400)
  })

  it('truncates at maxDelayMs', () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 250 }
    expect(computeBackoffDelayMs(5, null, policy, maxJitter)).toBe(250)
  })

  it('applies full jitter across the window, not a fixed offset', () => {
    const policy = { baseDelayMs: 1000, maxDelayMs: 10_000 }
    // Full jitter means a low random draw yields a proportionally low delay —
    // this is what de-synchronizes concurrent retries from a deck compile.
    expect(computeBackoffDelayMs(0, null, policy, () => 0)).toBe(0)
    expect(computeBackoffDelayMs(0, null, policy, () => 0.5)).toBe(500)
  })

  it('honors a numeric Retry-After over the computed backoff', () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 60_000 }
    expect(computeBackoffDelayMs(0, '5', policy, maxJitter)).toBe(5000)
  })

  it('clamps Retry-After to maxDelayMs so an interactive route cannot be parked', () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 8000 }
    expect(computeBackoffDelayMs(0, '120', policy, maxJitter)).toBe(8000)
  })

  it('falls back to exponential backoff for an unparseable Retry-After', () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 10_000 }
    expect(computeBackoffDelayMs(1, 'not-a-date', policy, maxJitter)).toBe(200)
  })

  it('never returns a negative delay for a past Retry-After date', () => {
    const past = new Date(Date.now() - 60_000).toUTCString()
    expect(computeBackoffDelayMs(0, past, { baseDelayMs: 100, maxDelayMs: 10_000 })).toBe(0)
  })
})

describe('googleFetch retry behavior', () => {
  const noDelay = { retry: { baseDelayMs: 0, maxDelayMs: 0, attempts: 3 } }

  it('retries a 429 and returns the eventual success', async () => {
    const fetchMock = stubResponses([
      text('rate limited', 429),
      json({ ok: true }),
    ])
    const result = await googleFetch<{ ok: boolean }>('https://example.test/x', 'tok', noDelay)
    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after the attempt budget and throws the legacy-format message', async () => {
    stubResponses([text('boom', 503), text('boom', 503), text('boom', 503)])
    // The "Google API error <status>:" shape is load-bearing —
    // mapGoogleErrorToStatus parses the status out of it.
    await expect(googleFetch('https://example.test/x', 'tok', noDelay)).rejects.toThrow(
      /Google API error 503: boom/,
    )
  })

  it('fails fast on an insufficient-scope 403 without retrying', async () => {
    const fetchMock = stubResponses([
      text('{"error":{"message":"Request had insufficient authentication scopes."}}', 403),
    ])
    await expect(googleFetch('https://example.test/x', 'tok', noDelay)).rejects.toThrow(/403/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 404', async () => {
    const fetchMock = stubResponses([text('not found', 404)])
    await expect(googleFetch('https://example.test/x', 'tok', noDelay)).rejects.toThrow(/404/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends the bearer token and JSON content type by default', async () => {
    const fetchMock = stubResponses([json({})])
    await googleFetch('https://example.test/x', 'tok-123')
    const init = fetchMock.mock.calls[0][1]
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-123')
    expect(headers['Content-Type']).toBe('application/json')
  })
})

describe('buildMultipartBody', () => {
  it('pairs metadata and content with CRLF delimiters and a closing boundary', () => {
    const body = buildMultipartBody({ name: 'Doc' }, '# Hello', 'text/markdown')

    expect(body).toContain('Content-Type: application/json; charset=UTF-8')
    expect(body).toContain('{"name":"Doc"}')
    expect(body).toContain('Content-Type: text/markdown')
    expect(body).toContain('# Hello')
    // A malformed terminator is an opaque Drive 400 — assert it explicitly.
    expect(body.trimEnd().endsWith('--')).toBe(true)
    expect(body).toContain('\r\n')
  })
})

describe('driveMultipartUpload', () => {
  it('POSTs to the upload endpoint for a new file', async () => {
    const fetchMock = stubResponses([json({ id: 'file-1' })])
    await driveMultipartUpload('tok', { name: 'X' }, 'body', 'text/markdown', { fields: 'id' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/upload/drive/v3/files')
    expect(url).toContain('uploadType=multipart')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['Content-Type']).toMatch(/^multipart\/related; boundary=/)
  })

  it('PATCHes the file id when replacing existing content', async () => {
    const fetchMock = stubResponses([json({ id: 'file-1' })])
    await driveMultipartUpload('tok', {}, 'new', 'text/markdown', { fileId: 'file-1' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/upload/drive/v3/files/file-1')
    expect(init?.method).toBe('PATCH')
  })
})
