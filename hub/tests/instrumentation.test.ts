import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { _resetProcessFaultStateForTests } from '@/lib/fault-process'

/* ════════════════════════════════════════════════════════════════════════════
   The instrumentation hook (§13.1): register() installs the process handlers
   under NEXT_RUNTIME=nodejs and installs NOTHING under edge.

   The edge half is not a formality — instrumentation.ts is evaluated in BOTH
   runtimes, and a top-level (rather than gated dynamic) import of the Node-only
   fault-process module would break the Edge bundle at build time.

   NOTE what this suite cannot prove: that Next actually CALLS register() in a
   real server. That depends on experimental.instrumentationHook, which no unit
   test can observe — hence scripts/assert-instrumentation.mjs as a build gate.
   ════════════════════════════════════════════════════════════════════════════ */

const TRACKED = ['uncaughtExceptionMonitor', 'unhandledRejection', 'SIGTERM', 'SIGINT'] as const

function counts(): Record<string, number> {
  return Object.fromEntries(TRACKED.map((e) => [e, process.listenerCount(e as NodeJS.Signals)]))
}

let runtimeBefore: string | undefined
let baseline: Record<string, number>

beforeEach(() => {
  runtimeBefore = process.env.NEXT_RUNTIME
  _resetProcessFaultStateForTests()
  baseline = counts()
})

afterEach(() => {
  // Remove anything register() added, so suites stay independent.
  for (const ev of TRACKED) {
    const ls = process.listeners(ev as NodeJS.Signals)
    for (const l of ls.slice(baseline[ev])) process.removeListener(ev as NodeJS.Signals, l as never)
  }
  if (runtimeBefore === undefined) delete process.env.NEXT_RUNTIME
  else process.env.NEXT_RUNTIME = runtimeBefore
  _resetProcessFaultStateForTests()
  vi.resetModules()
})

describe('register()', () => {
  it('installs the process handlers under the nodejs runtime', async () => {
    process.env.NEXT_RUNTIME = 'nodejs'
    const { register } = await import('../instrumentation')
    await register()
    const after = counts()
    expect(after.uncaughtExceptionMonitor).toBe(baseline.uncaughtExceptionMonitor + 1)
    expect(after.unhandledRejection).toBe(baseline.unhandledRejection + 1)
    expect(after.SIGTERM).toBe(baseline.SIGTERM + 1)
    expect(after.SIGINT).toBe(baseline.SIGINT + 1)
  })

  it('installs NOTHING under the edge runtime', async () => {
    process.env.NEXT_RUNTIME = 'edge'
    const { register } = await import('../instrumentation')
    await register()
    expect(counts()).toEqual(baseline)
  })

  it('installs nothing when the runtime is unset (never assume nodejs)', async () => {
    delete process.env.NEXT_RUNTIME
    const { register } = await import('../instrumentation')
    await register()
    expect(counts()).toEqual(baseline)
  })

  it('is safe to call twice — the latch prevents duplicate listeners', async () => {
    process.env.NEXT_RUNTIME = 'nodejs'
    const { register } = await import('../instrumentation')
    await register()
    const afterFirst = counts()
    await register()
    expect(counts()).toEqual(afterFirst)
  })

  it('does NOT export onRequestError — that hook is Next 15.0.0+ and would silently never fire', async () => {
    const mod = await import('../instrumentation')
    expect('onRequestError' in mod).toBe(false)
  })
})
