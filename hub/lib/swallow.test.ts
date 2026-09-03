import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { swallow, emptyOn, getSwallowCounters, setPartialMarker, _resetSwallowStateForTests } from './swallow'

/* ════════════════════════════════════════════════════════════════════════════
   swallow / emptyOn (lib/swallow.ts) — the named `.catch(() => …)`. What
   licenses replacing 125 sites with it: it NEVER throws for any input, the
   swallow/emptyOn split is visible in the counters, and only emptyOn touches
   the request-scoped partial marker. The module is imported by client code,
   so nothing here may rely on a server-only mock.
   ════════════════════════════════════════════════════════════════════════════ */

const ctx = { module: 'gmail-client', op: 'listLabels' } as const

let debugSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  _resetSwallowStateForTests()
  debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  debugSpy.mockRestore()
})

describe('counters', () => {
  it('swallow ticks swallowed only; emptyOn ticks both', () => {
    swallow(new Error('a'), ctx)
    swallow(new Error('b'), ctx)
    emptyOn(new Error('c'), ctx, [])
    expect(getSwallowCounters()).toEqual({ swallowed: 3, partial: 1 })
  })

  it('the snapshot is a copy — mutating it does not touch module state', () => {
    swallow(new Error('a'), ctx)
    const snap = getSwallowCounters() as { swallowed: number }
    snap.swallowed = 99
    expect(getSwallowCounters().swallowed).toBe(1)
  })

  it('_resetSwallowStateForTests zeroes the counters', () => {
    emptyOn(new Error('a'), ctx, null)
    _resetSwallowStateForTests()
    expect(getSwallowCounters()).toEqual({ swallowed: 0, partial: 0 })
  })
})

describe('the fallback contract', () => {
  it('emptyOn returns exactly the fallback it was given (identity, any type)', () => {
    const arr: string[] = []
    expect(emptyOn(new Error('x'), ctx, arr)).toBe(arr)
    expect(emptyOn(new Error('x'), ctx, null)).toBeNull()
    expect(emptyOn(new Error('x'), ctx, 0)).toBe(0)
    expect(emptyOn(new Error('x'), ctx, undefined)).toBeUndefined()
  })

  it('swallow returns nothing', () => {
    expect(swallow(new Error('x'), ctx)).toBeUndefined()
  })
})

describe('the partial marker is invoked by emptyOn ONLY', () => {
  it('swallow never calls the marker; emptyOn calls it once per call', () => {
    const marker = vi.fn()
    setPartialMarker(marker)
    swallow(new Error('a'), ctx)
    expect(marker).not.toHaveBeenCalled()
    emptyOn(new Error('b'), ctx, [])
    emptyOn(new Error('c'), ctx, [])
    expect(marker).toHaveBeenCalledTimes(2)
  })

  it('with no marker registered (the client case) emptyOn still counts and returns', () => {
    expect(emptyOn(new Error('x'), ctx, 'fb')).toBe('fb')
    expect(getSwallowCounters().partial).toBe(1)
  })

  it('a THROWING marker cannot turn a degraded read into a throw', () => {
    setPartialMarker(() => {
      throw new Error('marker exploded')
    })
    expect(() => emptyOn(new Error('x'), ctx, [])).not.toThrow()
    expect(getSwallowCounters().partial).toBe(1)
  })

  it('reset unregisters the marker', () => {
    const marker = vi.fn()
    setPartialMarker(marker)
    _resetSwallowStateForTests()
    emptyOn(new Error('x'), ctx, [])
    expect(marker).not.toHaveBeenCalled()
  })
})

describe('never throws, for any input', () => {
  const inputs: unknown[] = [
    new Error('plain'),
    new TypeError('typed'),
    'a string',
    42,
    null,
    undefined,
    { code: 'ENOENT' },
    [1, 2, 3],
    Symbol('sym'),
    () => {},
    Object.create(null),
    // circular — JSON.stringify would throw
    (() => {
      const o: Record<string, unknown> = {}
      o.self = o
      return o
    })(),
    // a throwing getter — even reading the message can explode
    Object.defineProperty(new Error('x'), 'message', {
      get() {
        throw new Error('getter exploded')
      },
    }),
  ]

  it.each(inputs.map((v, i) => [i, v]))('input #%i', (_i, value) => {
    expect(() => swallow(value, ctx)).not.toThrow()
    expect(() => emptyOn(value, ctx, [])).not.toThrow()
  })

  it('survives a broken console', () => {
    debugSpy.mockImplementation(() => {
      throw new Error('console is gone')
    })
    expect(() => swallow(new Error('x'), ctx)).not.toThrow()
    expect(() => emptyOn(new Error('x'), ctx, [])).not.toThrow()
    expect(getSwallowCounters()).toEqual({ swallowed: 2, partial: 1 })
  })
})

describe('the debug line carries the ctx fields', () => {
  it('module/op/code/severity and the error summary', () => {
    swallow(new RangeError('too big'), { ...ctx, code: 'upstream_4xx', severity: 'degraded' })
    expect(debugSpy).toHaveBeenCalledTimes(1)
    const [tag, fields] = debugSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(tag).toBe('[swallow]')
    expect(fields).toMatchObject({
      module: 'gmail-client',
      op: 'listLabels',
      code: 'upstream_4xx',
      severity: 'degraded',
      partial: false,
      errName: 'RangeError',
      message: 'too big',
    })
  })

  it('defaults: swallow is expected, emptyOn is degraded; code is null when absent', () => {
    swallow(new Error('a'), ctx)
    emptyOn(new Error('b'), ctx, [])
    const [, s] = debugSpy.mock.calls[0] as [string, Record<string, unknown>]
    const [, e] = debugSpy.mock.calls[1] as [string, Record<string, unknown>]
    expect(s).toMatchObject({ severity: 'expected', partial: false, code: null })
    expect(e).toMatchObject({ severity: 'degraded', partial: true, code: null })
  })

  it('a site-supplied severity overrides the default', () => {
    emptyOn(new Error('b'), { ...ctx, severity: 'expected' }, [])
    const [, e] = debugSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(e.severity).toBe('expected')
  })

  it('non-Error inputs are summarized, and long messages are truncated', () => {
    swallow('a bare string', ctx)
    swallow(undefined, ctx)
    swallow(new Error('x'.repeat(1000)), ctx)
    const calls = debugSpy.mock.calls.map((c) => c[1] as Record<string, unknown>)
    expect(calls[0]).toMatchObject({ errName: 'string', message: 'a bare string' })
    expect(calls[1]).toMatchObject({ errName: 'undefined', message: '' })
    expect((calls[2].message as string).length).toBeLessThan(1000)
    expect(calls[2].message).toMatch(/…$/)
  })
})
