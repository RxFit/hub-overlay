import { describe, it, expect, vi } from 'vitest'
import { withRetry } from './retry'

/**
 * withRetry — exponential-backoff retry wrapper.
 *
 * The contract under test:
 *  - transient upstream failures (5xx, network/timeout errors) are retried
 *    up to maxAttempts, then the LAST error is thrown;
 *  - deterministic failures (4xx, unrecognized errors) are NOT retried —
 *    they surface immediately after a single attempt.
 *
 * All tests use baseMs: 1 so backoff sleeps are ~1-3ms and the suite stays fast.
 */
describe('withRetry', () => {
  it('returns the value without retrying when the first attempt succeeds', async () => {
    const fn = vi.fn(async () => 'ok')
    await expect(withRetry(fn, { baseMs: 1 })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries a 503 upstream error and succeeds on a later attempt', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('Google API error 503: backend unavailable'))
      .mockResolvedValueOnce('recovered')
    await expect(withRetry(fn, { baseMs: 1, jitter: false })).resolves.toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries network-style errors (ECONNRESET / AbortError)', async () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('connect ECONNRESET upstream'))
      .mockRejectedValueOnce(abort)
      .mockResolvedValueOnce('up again')
    await expect(withRetry(fn, { maxAttempts: 3, baseMs: 1 })).resolves.toBe('up again')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry a 4xx error — deterministic failures surface immediately', async () => {
    const fn = vi.fn(async () => {
      throw new Error('Google API error 404: not found')
    })
    await expect(withRetry(fn, { maxAttempts: 5, baseMs: 1 })).rejects.toThrow('404')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry an unrecognized error', async () => {
    const fn = vi.fn(async () => {
      throw new Error('validation failed: label is required')
    })
    await expect(withRetry(fn, { maxAttempts: 3, baseMs: 1 })).rejects.toThrow('validation failed')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxAttempts and throws the LAST error', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('upstream 500 (first)'))
      .mockRejectedValueOnce(new Error('upstream 502 (second)'))
      .mockRejectedValueOnce(new Error('upstream 504 (third)'))
    await expect(withRetry(fn, { maxAttempts: 3, baseMs: 1, jitter: false })).rejects.toThrow(
      'upstream 504 (third)',
    )
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('treats a message containing BOTH a 4xx token and a retryable token as non-retryable', async () => {
    // The 4xx guard wins: "429" contains no 4\d\d? it does — 429 matches \b4\d{2}\b.
    // A 429 is therefore classified as deterministic and NOT retried.
    const fn = vi.fn(async () => {
      throw new Error('rate limited 429: timeout budget exceeded')
    })
    await expect(withRetry(fn, { maxAttempts: 3, baseMs: 1 })).rejects.toThrow('429')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries non-Error throwables when their string form is retryable', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce('fetch failed')
      .mockResolvedValueOnce('ok')
    await expect(withRetry(fn, { baseMs: 1 })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
