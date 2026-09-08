import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withRetry, type RetryAttemptInfo } from './retry'
import { reportFault } from '@/lib/fault-report'
import { CircuitOpenError } from '@/lib/circuit-breaker'
import { AppError } from '@/lib/errors'

// The reporter is the one side effect withRetry has; capture the draft it is
// handed instead of letting it hit stdout / the DB sink.
vi.mock('@/lib/fault-report', () => ({ reportFault: vi.fn() }))
// lib/circuit-breaker.ts imports the event logger and pino at module scope;
// only the error class is needed here.
vi.mock('@/lib/event-logger', () => ({ recordEvent: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

const reportFaultMock = vi.mocked(reportFault)

/**
 * withRetry — exponential-backoff retry wrapper.
 *
 * The contract under test:
 *  - transient upstream failures (5xx, network/timeout errors) are retried
 *    up to maxAttempts, then the LAST error is thrown;
 *  - deterministic failures (4xx, unrecognized errors) are NOT retried —
 *    they surface immediately after a single attempt;
 *  - CircuitOpenError is refused by POLICY, not by message shape;
 *  - `onAttempt` observes every failed attempt and can never break the retry;
 *  - the OTel rule (spec §4): a recovery reports ONE degraded fault with
 *    retryCount:n; an exhaustion reports NOTHING here and instead stamps a
 *    non-enumerable `retryCount` on the thrown error for the boundary;
 *  - the recovered record is filed under the taxonomy code the retry
 *    decision was made on (upstream_5xx / upstream_unavailable / timeout_*),
 *    never `internal`; an AppError or an aborted attempt keeps its own verdict.
 *
 * All tests use baseMs: 1 so backoff sleeps are ~1-3ms and the suite stays fast.
 */
describe('withRetry', () => {
  beforeEach(() => {
    reportFaultMock.mockClear()
  })

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

  it('maxAttempts <= 0 is floored to ONE attempt (pinned: the old loop threw `undefined` without calling fn)', async () => {
    // Deliberate, documented divergence from the pre-rewrite loop — see the
    // why-comment on `maxAttempts` in lib/retry.ts. Pinned here so the
    // choice is visible rather than an accident of `for (;;)`.
    const ok = vi.fn(async () => 'ran')
    await expect(withRetry(ok, { maxAttempts: 0, baseMs: 1 })).resolves.toBe('ran')
    expect(ok).toHaveBeenCalledTimes(1)

    const err = new Error('upstream 503')
    const bad = vi.fn(async () => {
      throw err
    })
    const onAttempt = vi.fn()
    await expect(withRetry(bad, { maxAttempts: -2, baseMs: 1, onAttempt })).rejects.toBe(err)
    expect(bad).toHaveBeenCalledTimes(1)
    expect(onAttempt).toHaveBeenCalledWith({ attempt: 1, maxAttempts: 1, err, willRetry: false, delayMs: 0 })
    expect(Object.getOwnPropertyDescriptor(err, 'retryCount')).toBeUndefined()
  })
})

describe('withRetry — onAttempt', () => {
  beforeEach(() => {
    reportFaultMock.mockClear()
  })

  it('fires once per FAILED attempt with attempt/willRetry/delayMs; delayMs is the backoff, 0 on the last', async () => {
    const e1 = new Error('upstream 500 (first)')
    const e2 = new Error('upstream 502 (second)')
    const e3 = new Error('upstream 504 (third)')
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(e1)
      .mockRejectedValueOnce(e2)
      .mockRejectedValueOnce(e3)
    const seen: RetryAttemptInfo[] = []
    await expect(
      withRetry(fn, { maxAttempts: 3, baseMs: 1, jitter: false, onAttempt: (i) => seen.push(i) }),
    ).rejects.toBe(e3)

    expect(seen).toHaveLength(3)
    // baseMs * 2^(attempt-1): 1, 2, then 0 because nothing follows the last.
    expect(seen[0]).toEqual({ attempt: 1, maxAttempts: 3, err: e1, willRetry: true, delayMs: 1 })
    expect(seen[1]).toEqual({ attempt: 2, maxAttempts: 3, err: e2, willRetry: true, delayMs: 2 })
    expect(seen[2]).toEqual({ attempt: 3, maxAttempts: 3, err: e3, willRetry: false, delayMs: 0 })
  })

  it('reports willRetry:false and delayMs:0 for a non-retryable first failure', async () => {
    const err = new Error('Google API error 404: not found')
    const fn = vi.fn(async () => {
      throw err
    })
    const onAttempt = vi.fn()
    await expect(withRetry(fn, { maxAttempts: 3, baseMs: 1, jitter: false, onAttempt })).rejects.toBe(err)
    expect(onAttempt).toHaveBeenCalledTimes(1)
    expect(onAttempt).toHaveBeenCalledWith({ attempt: 1, maxAttempts: 3, err, willRetry: false, delayMs: 0 })
  })

  it('is NOT called on a first-try success', async () => {
    const onAttempt = vi.fn()
    await expect(withRetry(async () => 'ok', { baseMs: 1, onAttempt })).resolves.toBe('ok')
    expect(onAttempt).not.toHaveBeenCalled()
  })

  it('a throwing onAttempt does not break the retry', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('upstream 503'))
      .mockResolvedValueOnce('recovered')
    const onAttempt = vi.fn(() => {
      throw new Error('observer exploded')
    })
    await expect(withRetry(fn, { baseMs: 1, jitter: false, onAttempt })).resolves.toBe('recovered')
    expect(onAttempt).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('withRetry — the OTel rule (spec §4: one degraded record, never n errors)', () => {
  beforeEach(() => {
    reportFaultMock.mockClear()
  })

  it('recovery after 2 failures → reportFault called exactly ONCE with a degraded draft carrying retryCount 2', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('upstream 503 (first)'))
      .mockRejectedValueOnce(new Error('connect ECONNRESET (second)'))
      .mockResolvedValueOnce('recovered')
    await expect(
      withRetry(fn, { maxAttempts: 3, baseMs: 1, jitter: false, module: 'gmail-client', op: 'listLabels' }),
    ).resolves.toBe('recovered')

    expect(reportFaultMock).toHaveBeenCalledTimes(1)
    const draft = reportFaultMock.mock.calls[0][0]
    expect(draft.severity).toBe('degraded')
    expect(draft.outcome).toBe('degraded')
    expect(draft.retryCount).toBe(2)
    expect(draft.module).toBe('gmail-client')
    expect(draft.layer).toBe('lib')
    // `op` rides context through lib/fault.ts's allowlist ('op' is listed).
    expect(draft.context).toEqual({ op: 'listLabels' })
    // The draft describes the LAST swallowed failure, not the first.
    expect(draft.message).toContain('ECONNRESET')
  })

  it('defaults attribution to module "retry" / op "withRetry" when the caller gives none', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('upstream 502'))
      .mockResolvedValueOnce('ok')
    await withRetry(fn, { baseMs: 1, jitter: false })
    expect(reportFaultMock).toHaveBeenCalledTimes(1)
    const draft = reportFaultMock.mock.calls[0][0]
    expect(draft.module).toBe('retry')
    expect(draft.context).toEqual({ op: 'withRetry' })
    expect(draft.retryCount).toBe(1)
  })

  it('a recovered plain "status 503" error is filed as upstream_5xx (blame upstream, retryable) — never internal', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('GET /v1/things failed with status 503'))
      .mockResolvedValueOnce('recovered')
    await expect(withRetry(fn, { baseMs: 1, jitter: false })).resolves.toBe('recovered')
    expect(reportFaultMock).toHaveBeenCalledTimes(1)
    const draft = reportFaultMock.mock.calls[0][0]
    expect(draft.code).toBe('upstream_5xx')
    expect(draft.blame).toBe('upstream')
    expect(draft.isRetryable).toBe(true)
    // The caller's overrides still win where they apply.
    expect(draft.severity).toBe('degraded')
    expect(draft.outcome).toBe('degraded')
    expect(draft.retryCount).toBe(1)
    expect(draft.context).toEqual({ op: 'withRetry' })
  })

  it.each([
    ['fetch failed', 'upstream_unavailable', 'upstream'],
    ['connect ECONNREFUSED upstream', 'upstream_unavailable', 'upstream'],
    ['read ECONNRESET', 'upstream_unavailable', 'upstream'],
    ['network error', 'upstream_unavailable', 'upstream'],
    ['connect ETIMEDOUT', 'timeout_connect', 'timeout'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout_connect', 'timeout'],
    ['request timeout waiting for headers', 'timeout_idle', 'timeout'],
    ['bad gateway 502', 'upstream_5xx', 'upstream'],
  ])('every shape isRetryable() accepts has a taxonomy code: %s → %s', async (message, code, blame) => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce('ok')
    await expect(withRetry(fn, { baseMs: 1, jitter: false })).resolves.toBe('ok')
    expect(reportFaultMock).toHaveBeenCalledTimes(1)
    const draft = reportFaultMock.mock.calls[0][0]
    expect(draft.code).toBe(code)
    expect(draft.blame).toBe(blame)
    expect(draft.isRetryable).toBe(true)
  })

  it('an AppError keeps its own code on the recovered record — the re-filing covers only the unclassified case', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new AppError('provider returned status 503', { code: 'ai_provider_error' }))
      .mockResolvedValueOnce('ok')
    await expect(withRetry(fn, { baseMs: 1, jitter: false })).resolves.toBe('ok')
    const draft = reportFaultMock.mock.calls[0][0]
    expect(draft.code).toBe('ai_provider_error')
  })

  it('a recovered AbortError stays cancelled — a user abort is never re-filed as an upstream fault', async () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(abort).mockResolvedValueOnce('ok')
    await expect(withRetry(fn, { baseMs: 1, jitter: false })).resolves.toBe('ok')
    const draft = reportFaultMock.mock.calls[0][0]
    expect(draft.outcome).toBe('cancelled')
    expect(draft.code).toBe('internal')
  })

  it('first-try success → reportFault not called', async () => {
    await expect(withRetry(async () => 'ok', { baseMs: 1 })).resolves.toBe('ok')
    expect(reportFaultMock).not.toHaveBeenCalled()
  })

  it('exhaustion → NO report here; the SAME error object is thrown, annotated with a NON-enumerable retryCount', async () => {
    const last = new Error('upstream 504 (third)')
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('upstream 500 (first)'))
      .mockRejectedValueOnce(new Error('upstream 502 (second)'))
      .mockRejectedValueOnce(last)

    let caught: unknown
    try {
      await withRetry(fn, { maxAttempts: 3, baseMs: 1, jitter: false })
    } catch (err) {
      caught = err
    }

    expect(reportFaultMock).not.toHaveBeenCalled()
    expect(caught).toBe(last)
    expect((caught as { retryCount?: unknown }).retryCount).toBe(2) // maxAttempts - 1
    expect(Object.keys(caught as object)).not.toContain('retryCount')
    expect(JSON.stringify(caught)).not.toContain('retryCount')
    expect(Object.getOwnPropertyDescriptor(caught, 'retryCount')).toMatchObject({
      enumerable: false,
      configurable: true,
    })
  })

  it('a frozen error is still thrown as-is (annotation is best-effort, never a different throw)', async () => {
    const frozen = Object.freeze(new Error('upstream 503 frozen'))
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('upstream 500'))
      .mockRejectedValueOnce(frozen)
    await expect(withRetry(fn, { maxAttempts: 2, baseMs: 1, jitter: false })).rejects.toBe(frozen)
    expect((frozen as { retryCount?: unknown }).retryCount).toBeUndefined()
  })

  it('a non-retryable 4xx → fn called once, thrown as-is, NO annotation', async () => {
    const err = new Error('Google API error 403: forbidden')
    const fn = vi.fn(async () => {
      throw err
    })
    await expect(withRetry(fn, { maxAttempts: 3, baseMs: 1 })).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(Object.getOwnPropertyDescriptor(err, 'retryCount')).toBeUndefined()
    expect(reportFaultMock).not.toHaveBeenCalled()
  })
})

describe('withRetry — CircuitOpenError is non-retryable BY POLICY', () => {
  it('fn called once, the error thrown as-is, nothing reported', async () => {
    const err = new CircuitOpenError('gmail')
    expect(err.name).toBe('CircuitOpenError')
    const fn = vi.fn(async () => {
      throw err
    })
    const onAttempt = vi.fn()
    await expect(withRetry(fn, { maxAttempts: 3, baseMs: 1, onAttempt })).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, willRetry: false, delayMs: 0 }))
    expect(reportFaultMock).not.toHaveBeenCalled()
  })

  it('refuses by NAME even when the message carries a retryable token', async () => {
    // The old behaviour only held because `Circuit open for "<key>"` has no
    // retryable token; a key like "gmail-timeout" would have been retried.
    const err = new CircuitOpenError('gmail-timeout')
    const fn = vi.fn(async () => {
      throw err
    })
    await expect(withRetry(fn, { maxAttempts: 3, baseMs: 1 })).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
