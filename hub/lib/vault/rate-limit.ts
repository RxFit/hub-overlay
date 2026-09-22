/**
 * Per-harness token bucket for the vault search route.
 *
 * Deliberately NOT lib/rate-limit.ts: that module's header pins it to the
 * chat route only ("no other route should pick up the limiter") and its
 * sliding window is keyed by user email. Search is called by machines
 * (Instinct, Claude Code, Hermes) and throttled per HARNESS — the identity
 * bound to the bearer key — so one busy harness cannot starve another.
 *
 * PER-INSTANCE, by design and documented as such in the runbook: the bucket
 * lives in this Node process. Cloud Run may run several instances, so the
 * effective ceiling is `capacity × instances`. That is acceptable for an
 * abuse/runaway-loop guard (the goal), not a billing quota (not the goal).
 * Stashed on globalThis like lib/rate-limit.ts so dev hot-reload does not
 * reset it.
 *
 * Tunables (env, read once at first use):
 *   VAULT_SEARCH_RATE_CAPACITY        burst size, default 30
 *   VAULT_SEARCH_RATE_REFILL_PER_SEC  sustained rate, default 0.5 (= 30/min)
 */

export interface TokenBucketOptions {
  capacity: number
  refillPerSecond: number
}

export interface TakeResult {
  allowed: boolean
  /** Whole tokens left after this call (0 when denied). */
  remaining: number
  /** Seconds until one token is available again (only when denied). */
  retryAfterSec?: number
}

interface Bucket {
  tokens: number
  updatedAt: number
}

export interface TokenBucket {
  take(key: string, now?: number): TakeResult
  readonly options: TokenBucketOptions
  _reset(): void
}

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const capacity = Math.max(1, options.capacity)
  const refillPerSecond = Math.max(0.001, options.refillPerSecond)
  const buckets = new Map<string, Bucket>()

  return {
    options: { capacity, refillPerSecond },
    take(key: string, now: number = Date.now()): TakeResult {
      let b = buckets.get(key)
      if (!b) {
        b = { tokens: capacity, updatedAt: now }
        buckets.set(key, b)
      } else {
        const elapsedSec = Math.max(0, now - b.updatedAt) / 1000
        b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSecond)
        b.updatedAt = now
      }
      if (b.tokens >= 1) {
        b.tokens -= 1
        return { allowed: true, remaining: Math.floor(b.tokens) }
      }
      const deficit = 1 - b.tokens
      return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil(deficit / refillPerSecond)) }
    },
    _reset() {
      buckets.clear()
    },
  }
}

function numberFromEnv(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

const globalState = globalThis as typeof globalThis & { __vaultSearchBucket?: TokenBucket }

/** The process-wide limiter the search route uses (per-instance on Cloud Run). */
export function getSearchRateLimiter(): TokenBucket {
  if (!globalState.__vaultSearchBucket) {
    globalState.__vaultSearchBucket = createTokenBucket({
      capacity: numberFromEnv('VAULT_SEARCH_RATE_CAPACITY', 30),
      refillPerSecond: numberFromEnv('VAULT_SEARCH_RATE_REFILL_PER_SEC', 0.5),
    })
  }
  return globalState.__vaultSearchBucket
}

/** Test hook: discard the process-wide limiter so env tunables are re-read. */
export function _resetSearchRateLimiterForTests(): void {
  delete globalState.__vaultSearchBucket
}
