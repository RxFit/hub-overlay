import { describe, it, expect } from 'vitest'
import { runWithPartialFlag, isPartial, markPartial } from './partial-context'
import { emptyOn, swallow } from './swallow'

/* ════════════════════════════════════════════════════════════════════════════
   partial-context (lib/partial-context.ts) — the AsyncLocalStorage flag that
   emptyOn() flips. The property that matters: it is REQUEST-scoped. Two
   concurrent handlers must never see each other's flag, or one degraded
   read would stamp x-hub-partial on an unrelated healthy response.

   NOTE: no _resetSwallowStateForTests here — it would unregister the marker
   this module installs on import, and the whole point of this file is that
   the real wiring works end to end.
   ════════════════════════════════════════════════════════════════════════════ */

const ctx = { module: 'calendar-client', op: 'listEvents' } as const

/** Yield to the microtask queue so the two scopes below genuinely interleave. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('scoping', () => {
  it('outside any scope: isPartial is false and emptyOn is a harmless no-op', () => {
    expect(isPartial()).toBe(false)
    expect(emptyOn(new Error('x'), ctx, [])).toEqual([])
    expect(isPartial()).toBe(false)
    expect(() => markPartial()).not.toThrow()
  })

  it('inside a scope: emptyOn flips the flag; swallow does not', async () => {
    const result = await runWithPartialFlag(async () => {
      expect(isPartial()).toBe(false)
      swallow(new Error('benign'), ctx)
      expect(isPartial()).toBe(false)
      emptyOn(new Error('lost'), ctx, null)
      return isPartial()
    })
    expect(result).toBe(true)
  })

  it('the flag survives awaits within the same scope', async () => {
    const result = await runWithPartialFlag(async () => {
      await tick()
      emptyOn(new Error('lost'), ctx, [])
      await tick()
      await Promise.resolve()
      return isPartial()
    })
    expect(result).toBe(true)
  })

  it('the flag does not leak out of the scope once it resolves', async () => {
    await runWithPartialFlag(async () => {
      emptyOn(new Error('lost'), ctx, [])
    })
    expect(isPartial()).toBe(false)
  })

  it('a synchronous fn works too, and throws propagate unchanged', () => {
    expect(runWithPartialFlag(() => 42)).toBe(42)
    const err = new Error('boom')
    expect(() =>
      runWithPartialFlag(() => {
        throw err
      }),
    ).toThrow(err)
  })
})

describe('THE test: two concurrent scopes do not leak into each other', () => {
  it('a degraded read in scope A never marks scope B (Promise.all interleaving)', async () => {
    const [a, b, c] = await Promise.all([
      runWithPartialFlag(async () => {
        await tick()
        emptyOn(new Error('A lost data'), ctx, [])
        await tick()
        return isPartial()
      }),
      runWithPartialFlag(async () => {
        await tick()
        await tick() // A has marked by now; B must not see it
        await tick()
        return isPartial()
      }),
      runWithPartialFlag(async () => {
        // marks LATE, after A and B have both read theirs
        await tick()
        await tick()
        await tick()
        await tick()
        emptyOn(new Error('C lost data'), ctx, [])
        return isPartial()
      }),
    ])
    expect(a).toBe(true)
    expect(b).toBe(false)
    expect(c).toBe(true)
    expect(isPartial()).toBe(false)
  })

  it('a fresh scope starts clean even when started from inside a marked one', async () => {
    const inner = await runWithPartialFlag(async () => {
      emptyOn(new Error('outer lost'), ctx, [])
      const nested = await runWithPartialFlag(async () => {
        await tick()
        return isPartial()
      })
      return { nested, outer: isPartial() }
    })
    expect(inner).toEqual({ nested: false, outer: true })
  })
})
