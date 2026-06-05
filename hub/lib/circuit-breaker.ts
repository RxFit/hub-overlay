import { recordEvent } from './event-logger'
import { createLogger } from './logger'

const log = createLogger('circuit-breaker')

export class CircuitOpenError extends Error {
  constructor(key: string) {
    super(`Circuit open for "${key}"`)
    this.name = 'CircuitOpenError'
  }
}

type CircuitState = 'closed' | 'open' | 'half-open'

interface CircuitEntry {
  state: CircuitState
  failures: number
  lastFailure: number
}

interface CircuitBreakerOpts {
  threshold?: number
  resetMs?: number
}

const DEFAULT_THRESHOLD = 3
const DEFAULT_RESET_MS = 60_000

export class CircuitBreaker {
  private entries = new Map<string, CircuitEntry>()
  private threshold: number
  private resetMs: number

  constructor(opts?: CircuitBreakerOpts) {
    this.threshold = opts?.threshold ?? DEFAULT_THRESHOLD
    this.resetMs = opts?.resetMs ?? DEFAULT_RESET_MS
  }

  async execute<T>(
    key: string,
    fn: () => Promise<T>,
    opts?: CircuitBreakerOpts,
  ): Promise<T> {
    const threshold = opts?.threshold ?? this.threshold
    const resetMs = opts?.resetMs ?? this.resetMs
    const entry = this.getEntry(key)
    const previousState = entry.state

    // Check if open circuit should transition to half-open
    if (entry.state === 'open') {
      if (Date.now() - entry.lastFailure >= resetMs) {
        entry.state = 'half-open'
        log.info({ key }, `Circuit transitioning to HALF-OPEN for key: ${key}`)
      } else {
        throw new CircuitOpenError(key)
      }
    }

    try {
      const result = await fn()
      // Success — reset
      entry.state = 'closed'
      entry.failures = 0

      if (previousState !== 'closed') {
        log.info({ key, previousState }, `Circuit recovered to CLOSED for key: ${key}`)
        recordEvent({
          eventType: 'circuit.reset',
          actor: 'system:circuit-breaker',
          resourceType: 'api',
          resourceId: key,
          payload: { previousState, state: 'closed' },
        }).catch(() => {})
      }

      return result
    } catch (err) {
      entry.failures++
      entry.lastFailure = Date.now()

      if (entry.failures >= threshold && previousState !== 'open') {
        entry.state = 'open'
        log.error(
          { key, failures: entry.failures, threshold },
          `Circuit tripped to OPEN for key: ${key}`,
        )
        recordEvent({
          eventType: 'circuit.tripped',
          actor: 'system:circuit-breaker',
          resourceType: 'api',
          resourceId: key,
          payload: { failures: entry.failures, threshold, state: 'open' },
        }).catch(() => {})
      }

      throw err
    }
  }

  getState(key: string): CircuitState {
    return this.getEntry(key).state
  }

  reset(key: string) {
    this.entries.delete(key)
  }

  private getEntry(key: string): CircuitEntry {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { state: 'closed', failures: 0, lastFailure: 0 }
      this.entries.set(key, entry)
    }
    return entry
  }
}

export const breaker = new CircuitBreaker()
