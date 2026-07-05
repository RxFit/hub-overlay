import { createLogger } from './logger'

const log = createLogger('rate-limit')

/**
 * Sliding-window rate limiter for /api/chat (Backend_Hardening_H1_M5_C6).
 *
 * /api/chat is the most expensive path in the app (Vertex + pgvector + Exa +
 * a model stream per request) and is excluded from the auth middleware
 * matcher, so it carries its own inbound throttle. Key = authenticated user
 * email; each key gets an independent window.
 *
 * In-memory by design: one Map per Next.js process, pruned on every check
 * plus a background sweep for keys that go quiet. Import this module ONLY
 * from the chat route — no other route should pick up the limiter.
 */

export const LIMIT = 15
export const WINDOW_MS = 60_000

const SWEEP_INTERVAL_MS = 5 * 60_000

/**
 * Global singleton state — same pattern as lib/circuit-breaker.ts's global
 * `breaker`, but stashed on globalThis so dev hot-reload re-evaluation reuses
 * the existing Map and never stacks a second sweep interval.
 */
const globalState = globalThis as typeof globalThis & {
  __rateLimitBuckets?: Map<string, number[]>
  __rateLimitSweep?: ReturnType<typeof setInterval>
}

const buckets: Map<string, number[]> =
  globalState.__rateLimitBuckets ?? (globalState.__rateLimitBuckets = new Map())

/**
 * Check (and count) one request for `key`. Timestamps older than the window
 * are pruned on every call, so memory per key is bounded by LIMIT.
 *
 * `now` is injectable for deterministic unit tests.
 */
export function checkRateLimit(
  key: string,
  now: number = Date.now(),
): { allowed: boolean; retryAfterSec?: number } {
  const cutoff = now - WINDOW_MS
  const timestamps = (buckets.get(key) ?? []).filter(t => t > cutoff)

  if (timestamps.length >= LIMIT) {
    buckets.set(key, timestamps)
    // Window slides open when the oldest in-window request ages out
    const retryAfterSec = Math.max(1, Math.ceil((timestamps[0] + WINDOW_MS - now) / 1000))
    log.warn({ key, limit: LIMIT, windowMs: WINDOW_MS, retryAfterSec }, `Rate limit exceeded for key: ${key}`)
    return { allowed: false, retryAfterSec }
  }

  timestamps.push(now)
  buckets.set(key, timestamps)
  return { allowed: true }
}

/**
 * Delete keys whose every timestamp has aged out of the window.
 * Exported as a test hook; the background interval calls it on real time.
 */
export function _sweep(now: number = Date.now()) {
  const cutoff = now - WINDOW_MS
  for (const [key, timestamps] of buckets) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
      buckets.delete(key)
    }
  }
}

/** Test hook: clear all limiter state between test cases. */
export function _reset() {
  buckets.clear()
}

if (!globalState.__rateLimitSweep) {
  const timer = setInterval(() => _sweep(), SWEEP_INTERVAL_MS) as ReturnType<typeof setInterval> & {
    unref?: () => void
  }
  // unref() so the sweep never holds the process open (tests, graceful shutdown)
  timer.unref?.()
  globalState.__rateLimitSweep = timer
}
