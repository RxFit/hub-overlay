import { recordEvent } from './event-logger'
import { createLogger } from './logger'
import { db } from './db'
import { circuitBreakers } from './schema'
import { eq, and } from 'drizzle-orm'

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
  probing?: boolean
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

    let entry: CircuitEntry = { state: 'closed', failures: 0, lastFailure: 0, probing: false }
    let useDb = false

    try {
      // 1. Try to fetch/initialize from database
      const [dbEntry] = await db.select().from(circuitBreakers).where(eq(circuitBreakers.key, key)).limit(1)
      if (!dbEntry) {
        await db.insert(circuitBreakers).values({
          key,
          state: 'closed',
          failures: 0,
          lastFailure: null,
          probing: false,
        }).onConflictDoNothing()
      } else {
        entry = {
          state: dbEntry.state as CircuitState,
          failures: dbEntry.failures,
          lastFailure: dbEntry.lastFailure ? new Date(dbEntry.lastFailure).getTime() : 0,
          probing: dbEntry.probing,
        }
      }
      useDb = true
    } catch (err) {
      // Graceful fallback to in-memory Map
      entry = this.getEntryLocal(key)
    }

    const previousState = entry.state

    if (useDb) {
      // Database-backed flow
      if (entry.state === 'open') {
        if (Date.now() - entry.lastFailure >= resetMs) {
          // Atomic update to HALF-OPEN and probing = true
          try {
            const updated = await db.update(circuitBreakers)
              .set({
                state: 'half-open',
                probing: true,
                updatedAt: new Date(),
              })
              .where(and(
                eq(circuitBreakers.key, key),
                eq(circuitBreakers.state, 'open'),
                eq(circuitBreakers.probing, false),
              ))
              .returning()

            if (updated.length > 0) {
              entry.state = 'half-open'
              entry.probing = true
              log.info({ key }, `Circuit transitioning to HALF-OPEN for key: ${key}`)
            } else {
              // Another instance/request won the probe, fast-fail
              throw new CircuitOpenError(key)
            }
          } catch (updateErr) {
            if (updateErr instanceof CircuitOpenError) throw updateErr
            // Fallback to memory on db error
            useDb = false
          }
        } else {
          throw new CircuitOpenError(key)
        }
      } else if (entry.state === 'half-open') {
        if (entry.probing) {
          // Probe already in progress, fast-fail
          throw new CircuitOpenError(key)
        } else {
          try {
            const updated = await db.update(circuitBreakers)
              .set({
                probing: true,
                updatedAt: new Date(),
              })
              .where(and(
                eq(circuitBreakers.key, key),
                eq(circuitBreakers.state, 'half-open'),
                eq(circuitBreakers.probing, false),
              ))
              .returning()

            if (updated.length > 0) {
              entry.probing = true
            } else {
              throw new CircuitOpenError(key)
            }
          } catch (updateErr) {
            if (updateErr instanceof CircuitOpenError) throw updateErr
            useDb = false
          }
        }
      }
    }

    // Double check: if we fallback to in-memory flow
    if (!useDb) {
      // In-memory flow
      const memEntry = this.getEntryLocal(key)
      if (memEntry.state === 'open') {
        if (Date.now() - memEntry.lastFailure >= resetMs) {
          if (memEntry.probing) {
            throw new CircuitOpenError(key)
          }
          memEntry.state = 'half-open'
          memEntry.probing = true
          log.info({ key }, `Circuit transitioning to HALF-OPEN for key: ${key}`)
        } else {
          throw new CircuitOpenError(key)
        }
      } else if (memEntry.state === 'half-open') {
        if (memEntry.probing) {
          throw new CircuitOpenError(key)
        }
        memEntry.probing = true
      }
      entry = memEntry
    }

    // Sync to local map for getState sync-queries
    this.syncLocalEntry(key, entry)

    try {
      const result = await fn()

      // SUCCESS PATH
      entry.state = 'closed'
      entry.failures = 0
      entry.probing = false
      this.syncLocalEntry(key, entry)

      if (useDb) {
        try {
          await db.update(circuitBreakers)
            .set({
              state: 'closed',
              failures: 0,
              probing: false,
              updatedAt: new Date(),
            })
            .where(eq(circuitBreakers.key, key))
        } catch (dbErr) {
          log.error({ dbErr }, `Failed to update circuit state in DB on success for key: ${key}`)
        }
      }

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
      // FAILURE PATH
      entry.probing = false
      entry.failures++
      entry.lastFailure = Date.now()

      let nextState = entry.state
      if (previousState === 'half-open' || entry.failures >= threshold) {
        nextState = 'open'
        entry.state = 'open'
      }
      this.syncLocalEntry(key, entry)

      if (useDb) {
        try {
          await db.update(circuitBreakers)
            .set({
              state: nextState,
              failures: entry.failures,
              lastFailure: new Date(entry.lastFailure),
              probing: false,
              updatedAt: new Date(),
            })
            .where(eq(circuitBreakers.key, key))
        } catch (dbErr) {
          log.error({ dbErr }, `Failed to update circuit state in DB on failure for key: ${key}`)
        }
      }

      if (nextState === 'open' && previousState !== 'open') {
        const tripReason = previousState === 'half-open'
          ? `Circuit probe failed. Tripping back to OPEN for key: ${key}`
          : `Circuit tripped to OPEN for key: ${key}`

        log.error(
          { key, failures: entry.failures, threshold },
          tripReason,
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
    return this.getEntryLocal(key).state
  }

  reset(key: string) {
    this.entries.delete(key)
  }

  private getEntry(key: string): CircuitEntry {
    return this.getEntryLocal(key)
  }

  private getEntryLocal(key: string): CircuitEntry {
    let entry = this.entries.get(key)
    if (entry) {
      // TTL eviction: remove stale closed circuits older than 5 minutes
      const TTL_MS = 5 * 60 * 1000
      if (entry.state === 'closed' && entry.lastFailure > 0 && Date.now() - entry.lastFailure > TTL_MS) {
        this.entries.delete(key)
        entry = undefined
      }
    }
    if (!entry) {
      entry = { state: 'closed', failures: 0, lastFailure: 0, probing: false }
      this.entries.set(key, entry)
    }
    return entry
  }

  private syncLocalEntry(key: string, entry: CircuitEntry) {
    this.entries.set(key, { ...entry })
    // Cap in-memory map at 50 entries — evict oldest closed circuits
    const MAX_ENTRIES = 50
    if (this.entries.size > MAX_ENTRIES) {
      for (const [k, v] of this.entries) {
        if (v.state === 'closed' && k !== key) {
          this.entries.delete(k)
          if (this.entries.size <= MAX_ENTRIES) break
        }
      }
    }
  }
}

export const breaker = new CircuitBreaker()
