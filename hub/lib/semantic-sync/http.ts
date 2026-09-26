/**
 * Shared HTTP plumbing for the semantic sync: a typed failure that names the
 * pipeline stage, and a small retry for the transient classes (429 / 5xx /
 * socket errors) every upstream here — GCS, Gmail, Stripe, Discovery Engine —
 * throws occasionally.
 *
 * Not lib/retry.ts: that helper classifies by scanning the error MESSAGE for
 * status tokens, and messages here carry object names and ids that can contain
 * "500" or "404" by accident. This one decides on the numeric status.
 */

export type SyncStage = 'config' | 'auth' | 'state' | 'collect' | 'upload' | 'import'

export class SemanticSyncError extends Error {
  readonly stage: SyncStage
  readonly httpStatus?: number

  constructor(stage: SyncStage, message: string, httpStatus?: number) {
    super(message)
    this.name = 'SemanticSyncError'
    this.stage = stage
    this.httpStatus = httpStatus
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const RETRY_DELAYS_MS = [400, 1500]

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

/**
 * fetch with up to two retries on 429/5xx/network failure. A 4xx other than
 * 429 is returned to the caller on the first attempt (deterministic), and an
 * abort is never retried — the run's deadline is the caller's to own.
 */
export async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetchImpl(url, init)
      const transient = res.status === 429 || res.status >= 500
      if (!transient || attempt === RETRY_DELAYS_MS.length) return res
      // Drain so the socket can be reused before retrying.
      await res.text().catch(() => '')
    } catch (err) {
      if (isAbort(err) || init.signal?.aborted) throw err
      lastErr = err
      if (attempt === RETRY_DELAYS_MS.length) throw err
    }
    await sleep(RETRY_DELAYS_MS[attempt])
  }
  // Unreachable: the loop returns or throws on its final attempt.
  throw lastErr instanceof Error ? lastErr : new Error('fetchWithRetry exhausted')
}

/** Google/Stripe error bodies → one bounded, non-echoing line. */
export function describeUpstreamError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } | string }
    const e = parsed.error
    if (typeof e === 'string') return e.slice(0, 300)
    if (e?.message) return (e.status ? `${e.status}: ${e.message}` : e.message).slice(0, 300)
  } catch {
    // not JSON — fall through
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 300) || '(empty error body)'
}

/** Throw a SemanticSyncError for a non-2xx response, with the upstream's own message. */
export async function failFromResponse(stage: SyncStage, what: string, res: Response): Promise<never> {
  const body = await res.text().catch(() => '')
  throw new SemanticSyncError(stage, `${what} failed (HTTP ${res.status}): ${describeUpstreamError(body)}`, res.status)
}

/** Run `fn` over `items` with at most `limit` in flight; rejects on the first failure. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const i = next++
      try {
        results[i] = await fn(items[i])
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
