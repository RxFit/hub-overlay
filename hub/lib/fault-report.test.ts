import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  reportFault,
  getFaultReportCounters,
  _resetFaultReportStateForTests,
  BUCKET_MAX,
  BUCKET_WINDOW_MS,
  CEILING_MAX,
} from './fault-report'
import { toFault, type FaultDraft } from './fault'

// The DB copy lazy-imports './event-logger'; vitest intercepts the dynamic
// import too, so no real DB module is ever touched here.
vi.mock('./event-logger', () => ({
  recordEventStrict: vi.fn(async () => {}),
  recordEvent: vi.fn(async () => {}),
}))
import { recordEventStrict } from './event-logger'
const strictMock = vi.mocked(recordEventStrict)

/* ════════════════════════════════════════════════════════════════════════════
   The fault reporter (lib/fault-report.ts) — the §8 volume controls, the
   unconditional stdout line, drop accounting (sinkFailed is REAL because the
   DB copy goes through recordEventStrict, which rejects), and the
   reporter-never-reports-itself latch.
   ════════════════════════════════════════════════════════════════════════════ */

function draft(message = 'boom'): FaultDraft {
  return toFault(new Error(message), { layer: 'route', route: '/api/probe', requestId: 'r1' })
}

const T0 = 1_700_000_000_000

let logSpy: ReturnType<typeof vi.spyOn>
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  _resetFaultReportStateForTests()
  strictMock.mockClear()
  strictMock.mockResolvedValue(undefined)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  savedEnv.OBSERVABILITY_ENABLED = process.env.OBSERVABILITY_ENABLED
  savedEnv.TELEMETRY_DB_SINK = process.env.TELEMETRY_DB_SINK
})

afterEach(() => {
  logSpy.mockRestore()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('the stdout line', () => {
  it('is emitted in GCP ReportedErrorEvent shape with the fault attached', () => {
    reportFault(draft(), { now: T0, rawStack: 'Error: boom\n    at f (/app/hub/lib/x.ts:1:1)' })
    expect(logSpy).toHaveBeenCalledTimes(1)
    const line = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(line.severity).toBe('ERROR')
    expect(line.serviceContext).toEqual({ service: 'hub', version: 'unknown' })
    expect(line.message).toContain('at f (')
    expect(line.fault.faultId).toMatch(/^HUB-/)
    expect(line.fault.ts).toBe(new Date(T0).toISOString())
    expect(line.fault.code).toBe('internal')
  })

  it('is UNCONDITIONAL — OBSERVABILITY_ENABLED=false does not silence it', () => {
    process.env.OBSERVABILITY_ENABLED = 'false'
    reportFault(draft(), { now: T0 })
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('the GCP message is scrubbed even though line numbers survive', () => {
    reportFault(draft(), {
      now: T0,
      rawStack: 'Error: denied for danny@rxfitatx.com\n    at f (/app/hub/lib/x.ts:12:3)',
    })
    const line = logSpy.mock.calls[0][0] as string
    expect(line).not.toContain('danny@')
    expect(JSON.parse(line).message).toMatch(/:12:3/)
  })
})

describe('volume control', () => {
  it(`per-fingerprint bucket: first ${BUCKET_MAX} in the window emit; the next only counts`, () => {
    const d = draft('same bug')
    for (let i = 0; i < BUCKET_MAX; i++) reportFault({ ...d }, { now: T0 + i })
    reportFault({ ...d }, { now: T0 + BUCKET_MAX })
    expect(logSpy).toHaveBeenCalledTimes(BUCKET_MAX)
    expect(getFaultReportCounters()).toMatchObject({ reported: BUCKET_MAX, suppressed: 1 })

    // …and the window rolls: after BUCKET_WINDOW_MS the same fingerprint
    // reports again.
    reportFault({ ...d }, { now: T0 + BUCKET_WINDOW_MS + 1 })
    expect(getFaultReportCounters().reported).toBe(BUCKET_MAX + 1)
  })

  it(`global ceiling: write ${CEILING_MAX} DISTINCT fingerprints, the next is shed and counted`, () => {
    const base = draft()
    for (let i = 0; i < CEILING_MAX; i++) {
      reportFault({ ...base, fingerprint: `fp${i}` }, { now: T0 + i })
    }
    reportFault({ ...base, fingerprint: 'one-more-brand-new' }, { now: T0 + CEILING_MAX })
    const c = getFaultReportCounters()
    expect(c.reported).toBe(CEILING_MAX)
    expect(c.ringFull).toBe(1)
    expect(logSpy).toHaveBeenCalledTimes(CEILING_MAX)
  })
})

describe('drop accounting — the sink can actually fail now', () => {
  it('a rejected recordEventStrict increments sinkFailed', async () => {
    process.env.TELEMETRY_DB_SINK = 'on' // explicit opt-in under NODE_ENV=test
    strictMock.mockRejectedValueOnce(new Error('db is down'))
    reportFault(draft(), { now: T0 })
    await vi.waitFor(() => expect(getFaultReportCounters().sinkFailed).toBe(1))
  })

  it('the DB copy carries the wire convention: telemetry:fault + correlation_id', async () => {
    process.env.TELEMETRY_DB_SINK = 'on'
    reportFault(draft(), { now: T0 })
    await vi.waitFor(() => expect(strictMock).toHaveBeenCalledTimes(1))
    const opts = strictMock.mock.calls[0][0]
    expect(opts.eventType).toBe('telemetry:fault')
    expect(opts.actor).toBe('system')
    expect(opts.correlationId).toBe('r1')
    expect((opts.payload as { code: string }).code).toBe('internal')
  })

  it('the sink respects the test-environment default (off unless opted in)', async () => {
    reportFault(draft(), { now: T0 })
    await new Promise((r) => setTimeout(r, 10))
    expect(strictMock).not.toHaveBeenCalled()
  })
})

describe('the reporter can never break anything', () => {
  it('never throws, even with console.log broken — and counts its own failure', () => {
    logSpy.mockImplementation(() => {
      throw new Error('stdout is gone')
    })
    expect(() => reportFault(draft(), { now: T0 })).not.toThrow()
    expect(getFaultReportCounters().selfFaults).toBe(1)
  })

  it('never reports itself: a fault raised inside the reporter hits the latch', () => {
    let reentered = false
    logSpy.mockImplementation(() => {
      if (!reentered) {
        reentered = true
        reportFault(draft('fault from inside the reporter'), { now: T0 })
      }
    })
    reportFault(draft(), { now: T0 })
    const c = getFaultReportCounters()
    expect(c.reported).toBe(1) // the outer one
    expect(c.selfFaults).toBe(1) // the inner one, latched
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('returns synchronously even when the DB write never settles', () => {
    process.env.TELEMETRY_DB_SINK = 'on'
    strictMock.mockReturnValue(new Promise(() => {}) as never) // a hung Postgres
    const before = Date.now()
    reportFault(draft(), { now: T0 })
    expect(Date.now() - before).toBeLessThan(50)
    expect(getFaultReportCounters().reported).toBe(1)
  })
})
