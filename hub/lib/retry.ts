interface RetryOpts {
  maxAttempts?: number
  baseMs?: number
  jitter?: boolean
  deadlineMs?: number  // Total wall-clock budget for all attempts
}

const RETRYABLE_STATUS = ['500', '502', '503', '504']
const RETRYABLE_NETWORK = [
  'AbortError',
  'fetch failed',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'network',
  'timeout',
]

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const name = err instanceof Error ? err.name : ''

  // Reject 4xx — deterministic failures should not be retried
  if (/\b4\d{2}\b/.test(msg)) return false

  // Retry on server error status codes
  if (RETRYABLE_STATUS.some((code) => msg.includes(code))) return true

  // Retry on network / timeout errors
  if (RETRYABLE_NETWORK.some((tok) => msg.includes(tok) || name.includes(tok))) return true

  return false
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOpts,
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3
  const baseMs = opts?.baseMs ?? 500
  const jitter = opts?.jitter ?? true
  const deadline = opts?.deadlineMs ? Date.now() + opts.deadlineMs : undefined

  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Pre-flight: abort if deadline would be exceeded
    if (deadline && Date.now() >= deadline) {
      throw lastError ?? new Error(`Retry deadline exceeded after ${attempt} attempts`)
    }
    try {
      return await fn()
    } catch (err) {
      lastError = err

      const isLast = attempt === maxAttempts - 1
      if (isLast || !isRetryable(err)) throw err

      const delay = baseMs * Math.pow(2, attempt)
      const jittered = jitter
        ? delay + Math.random() * delay * 0.3
        : delay

      await sleep(jittered)
    }
  }

  // Unreachable, but satisfies TypeScript
  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
