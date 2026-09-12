import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker'

/**
 * Proves the `vertex-ai` circuit can now actually OPEN.
 *
 * This is the defect itself, not a paraphrase of it. CircuitBreaker.execute
 * increments `failures` only in its catch and sets `failures = 0` on any resolved
 * value. While searchSemanticBrain returned `null` on every failure, each failure
 * resolved — so it was scored as a SUCCESS and RESET the counter. Three outages in
 * a row left `failures` at 0, the circuit never opened, and during a real outage
 * every chat turn paid the full search timeout with no protection at all.
 *
 * The first test below fails against the old `null`-returning contract. The second
 * is the control: it reproduces the old behaviour explicitly and shows the circuit
 * staying shut, so the guard rail cannot be satisfied by a breaker that trips on
 * everything.
 */
vi.mock('./event-logger', () => ({ recordEvent: vi.fn(async () => {}) }))
vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('vertex-ai circuit breaker', () => {
  it('opens after the threshold when the search REJECTS (the new contract)', async () => {
    const breaker = new CircuitBreaker({ threshold: 3, resetMs: 60_000 })
    const { VertexUnavailableError } = await import('./vertex')
    const unavailable = () => Promise.reject(new VertexUnavailableError('http', 'HTTP 503', 503))

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute('vertex-ai', unavailable)).rejects.toBeInstanceOf(VertexUnavailableError)
    }

    // 4th call never reaches the upstream — THE protection that did not exist.
    const fn = vi.fn(unavailable)
    await expect(breaker.execute('vertex-ai', fn)).rejects.toBeInstanceOf(CircuitOpenError)
    expect(fn).not.toHaveBeenCalled()
  })

  it('CONTROL: a null-returning search leaves the circuit shut forever', async () => {
    const breaker = new CircuitBreaker({ threshold: 3, resetMs: 60_000 })
    // Exactly what searchSemanticBrain used to do on every failure mode.
    const legacyFailure = () => Promise.resolve(null)

    for (let i = 0; i < 10; i++) {
      await expect(breaker.execute('vertex-ai', legacyFailure)).resolves.toBeNull()
    }

    const fn = vi.fn(legacyFailure)
    await expect(breaker.execute('vertex-ai', fn)).resolves.toBeNull()
    expect(fn).toHaveBeenCalled() // ten outages in a row, still dialling upstream
  })

  it('an empty result set does NOT count against the circuit', async () => {
    const breaker = new CircuitBreaker({ threshold: 3, resetMs: 60_000 })
    // `[]` means the search ran and matched nothing — a success, and it must not
    // be conflated with unavailability in either direction.
    for (let i = 0; i < 5; i++) {
      await expect(breaker.execute('vertex-ai', () => Promise.resolve([]))).resolves.toEqual([])
    }
    const fn = vi.fn(() => Promise.resolve([]))
    await expect(breaker.execute('vertex-ai', fn)).resolves.toEqual([])
    expect(fn).toHaveBeenCalled()
  })
})
