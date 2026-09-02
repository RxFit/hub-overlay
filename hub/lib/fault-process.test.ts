import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { installProcessFaultHandlers, _resetProcessFaultStateForTests } from './fault-process'

/* ════════════════════════════════════════════════════════════════════════════
   Process-level capture (lib/fault-process.ts, §3 Layer 8) — the last line of
   defense. The load-bearing properties: it OBSERVES without changing crash
   semantics, it writes SYNCHRONOUSLY (a buffered line dies with the process),
   it scrubs, and it can never itself throw on the crash path.
   ════════════════════════════════════════════════════════════════════════════ */

const WATCHED = ['uncaughtExceptionMonitor', 'unhandledRejection', 'SIGTERM', 'SIGINT', 'uncaughtException'] as const
type Watched = (typeof WATCHED)[number]

/** Listeners this suite added, so it can invoke them directly (never emit a
 *  real signal) and remove them afterwards. */
let added: Record<string, Function[]> = {}
let writes: string[] = []

/** Replace the sync stderr write with a capture. Declared as a helper rather
 *  than a typed variable: fs.writeSync is overloaded, so a MockInstance
 *  annotation for it does not typecheck cleanly. */
function stubStderr(impl?: (data: string) => void) {
  return vi.spyOn(fs, 'writeSync').mockImplementation(((_fd: number, data: string) => {
    if (impl) impl(String(data))
    else writes.push(String(data))
    return String(data).length
  }) as never)
}

function snapshot(): Record<string, Function[]> {
  const out: Record<string, Function[]> = {}
  for (const ev of WATCHED) out[ev] = [...process.listeners(ev as NodeJS.Signals)]
  return out
}

function install(surface: 'next-server' | 'dispatch-worker' = 'next-server') {
  const before = snapshot()
  const result = installProcessFaultHandlers({ surface })
  const after = snapshot()
  for (const ev of WATCHED) {
    const fresh = after[ev].filter((l) => !before[ev].includes(l))
    added[ev] = [...(added[ev] ?? []), ...fresh]
  }
  return result
}

/** Invoke the listener we registered for an event, directly. */
function fire(ev: Watched, ...args: unknown[]) {
  const listeners = added[ev] ?? []
  expect(listeners.length, `no listener registered for ${ev}`).toBeGreaterThan(0)
  for (const l of listeners) l(...args)
}

function lines(): Array<Record<string, any>> {
  return writes.filter((w) => w.trim().startsWith('{')).map((w) => JSON.parse(w))
}

beforeEach(() => {
  _resetProcessFaultStateForTests()
  added = {}
  writes = []
  stubStderr()
})

afterEach(() => {
  for (const [ev, ls] of Object.entries(added)) {
    for (const l of ls) process.removeListener(ev as NodeJS.Signals, l as never)
  }
  vi.restoreAllMocks()
  _resetProcessFaultStateForTests()
})

describe('what it registers — and what it deliberately does NOT', () => {
  it('observes via uncaughtExceptionMonitor and never registers an uncaughtException HANDLER', () => {
    install()
    expect(added.uncaughtExceptionMonitor).toHaveLength(1)
    // THE load-bearing assertion: a real uncaughtException handler would keep
    // a corrupted process serving traffic AND make it exit 0, so a crash
    // would report as a clean shutdown.
    expect(added.uncaughtException ?? []).toHaveLength(0)
  })

  it('registers the unhandledRejection listener ONLY on next-server', () => {
    install('next-server')
    expect(added.unhandledRejection).toHaveLength(1)
  })

  it('registers NO unhandledRejection listener on the worker — a listener would suppress the crash', () => {
    // Verified on node 22: ANY unhandledRejection listener suppresses Node's
    // default throw. On the plain-Node worker that would swallow a programmer
    // error and leave it claiming and executing dispatch jobs in a corrupted
    // state. Registering nothing costs no observability — the rejection is
    // promoted to an uncaught exception, so uncaughtExceptionMonitor reports
    // it with origin 'unhandledRejection' AND the process still dies.
    install('dispatch-worker')
    expect(added.unhandledRejection ?? []).toHaveLength(0)
    // ...and the monitor is still installed, so the class stays observable.
    expect(added.uncaughtExceptionMonitor).toHaveLength(1)
  })

  it('the worker still reports a promoted rejection through the monitor', () => {
    install('dispatch-worker')
    // What Node actually delivers when the default throw promotes it.
    fire('uncaughtExceptionMonitor', new Error('nobody awaited me'), 'unhandledRejection')
    const [line] = lines()
    expect(line.origin).toBe('unhandledRejection')
    expect(line.surface).toBe('dispatch-worker')
    expect(line.severity).toBe('CRITICAL')
  })

  it('registers shutdown listeners for both signals', () => {
    install()
    expect(added.SIGTERM).toHaveLength(1)
    expect(added.SIGINT).toHaveLength(1)
  })

  it('is idempotent — the worker imports it and register() can run twice', () => {
    expect(install()).toBe(true)
    expect(install()).toBe(false)
    expect(added.uncaughtExceptionMonitor).toHaveLength(1)
  })
})

describe('the crash line', () => {
  it('writes ONE synchronous CRITICAL line carrying the fault, never console.log', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    install()
    fire('uncaughtExceptionMonitor', new Error('boom from a timer'), 'uncaughtException')
    const [line] = lines()
    expect(line.severity).toBe('CRITICAL')
    expect(line.surface).toBe('next-server')
    expect(line.origin).toBe('uncaughtException')
    expect(line.fault.layer).toBe('process')
    expect(line.fault.severity).toBe('fatal')
    expect(line.fault.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(line.message).toContain('boom from a timer')
    // Synchronous only: a console.log buffer dies with the process.
    expect(logSpy).not.toHaveBeenCalled()
    expect(fs.writeSync).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('scrubs secrets out of the stack before they reach stderr', () => {
    install()
    const err = new Error('token exchange failed for danny@rxfitatx.com')
    err.stack = [
      'Error: token exchange failed',
      '    at refresh (/app/hub/lib/google/auth.ts:31:9) Bearer eyJhbGciOiJIUzI1NiJ9.body.sig',
      '    at tick (/app/hub/lib/agy.ts:12:3) postgres://u:hunter2@db.internal:5432/hub',
    ].join('\n')
    fire('uncaughtExceptionMonitor', err, 'uncaughtException')
    const serialized = JSON.stringify(lines()[0])
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('eyJ')
    expect(serialized).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/)
    // and the diagnosis survives the scrub
    expect(serialized).toContain('auth.ts')
  })

  it('labels the worker surface distinctly — "which process died" is question one', () => {
    install('dispatch-worker')
    fire('uncaughtExceptionMonitor', new Error('worker died'), 'uncaughtException')
    const [line] = lines()
    expect(line.surface).toBe('dispatch-worker')
    expect(line.serviceContext.service).toBe('hub-worker')
  })

  it('reports an unhandled rejection on next-server — where Next already suppressed the crash', () => {
    install('next-server')
    fire('unhandledRejection', new Error('nobody awaited me'), Promise.resolve())
    const [line] = lines()
    expect(line.origin).toBe('unhandledRejection')
    expect(line.severity).toBe('CRITICAL')
    expect(line.message).toContain('nobody awaited me')
  })

  it('normalizes a non-Error throw rather than dropping it', () => {
    install('next-server')
    fire('unhandledRejection', 'a bare string rejection', Promise.resolve())
    expect(lines()[0].message).toContain('a bare string rejection')
  })
})

describe('it can never make the crash worse', () => {
  it('survives a stderr that throws', () => {
    install()
    vi.spyOn(fs, 'writeSync').mockImplementation((() => {
      throw new Error('stderr is gone')
    }) as never)
    expect(() => fire('uncaughtExceptionMonitor', new Error('boom'), 'uncaughtException')).not.toThrow()
  })

  it('survives an un-serializable payload (circular error)', () => {
    install()
    const err: Error & { self?: unknown } = new Error('circular')
    err.self = err
    ;(err as unknown as Record<string, unknown>).toJSON = () => {
      throw new Error('nope')
    }
    expect(() => fire('uncaughtExceptionMonitor', err, 'uncaughtException')).not.toThrow()
  })
})

describe('shutdown', () => {
  it('logs the signal with the drop-accounting counters and NEVER calls process.exit', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit must not be called — it preempts next start\'s own drain')
    }) as never)
    install()
    expect(() => fire('SIGTERM')).not.toThrow()
    const line = lines().find((l) => l.signal === 'SIGTERM')
    expect(line).toBeDefined()
    expect(line!.severity).toBe('INFO')
    // The one moment per-instance drop accounting can be read.
    expect(line!.faultCounters).toMatchObject({
      reported: expect.any(Number),
      suppressed: expect.any(Number),
      ringFull: expect.any(Number),
      sinkFailed: expect.any(Number),
    })
    expect(exitSpy).not.toHaveBeenCalled()
    exitSpy.mockRestore()
  })
})
