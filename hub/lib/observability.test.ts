import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  emit,
  newRequestId,
  startTimer,
  hashEmail,
  observabilityEnabled,
  telemetryDbSinkEnabled,
  type TelemetryEvent,
} from './observability'

// The DB sink lazy-imports './event-logger'; vitest intercepts the dynamic
// import too, so no real DB module (or connection) is ever touched here.
vi.mock('./event-logger', () => ({ recordEvent: vi.fn(async () => {}) }))
import { recordEvent } from './event-logger'
const recordEventMock = vi.mocked(recordEvent)

/* ════════════════════════════════════════════════════════════════════════════
   AI-path observability emitter (lib/observability.ts)

   Covers: per-event emitted shape, the HARD PII-redaction guarantee (no raw
   email / message content / token ever reaches a log line), timer monotonicity,
   requestId format, and the OBSERVABILITY_ENABLED guard.
   ════════════════════════════════════════════════════════════════════════════ */

/** Capture one emit()'d line and parse it back to an object. */
function captureEmit(event: TelemetryEvent): Record<string, unknown> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    emit(event)
    expect(spy).toHaveBeenCalledTimes(1)
    return JSON.parse(spy.mock.calls[0][0] as string)
  } finally {
    spy.mockRestore()
  }
}

const SAMPLE_EVENTS: TelemetryEvent[] = [
  { type: 'ai_request_start', requestId: 'r1', route: '/api/chat' },
  { type: 'ai_provider_selected', requestId: 'r1', provider: 'claude', model: 'claude-fable-5', attempt: 1 },
  { type: 'ai_first_token', requestId: 'r1', ms: 123 },
  { type: 'ai_complete', requestId: 'r1', ms: 456, provider: 'gemini', model: 'gemini-2.5-flash', finishReason: 'stop' },
  { type: 'ai_timeout', requestId: 'r1', layer: 'idle', provider: 'gemini', model: 'gemini-2.5-pro' },
  { type: 'ai_fallback', requestId: 'r1', from: 'claude-fable-5', to: 'gemini-2.5-flash', reason: 'error' },
  { type: 'ai_error', requestId: 'r1', provider: 'gemini', code: 'auth', message: 'boom' },
]

describe('emit — per-event shape', () => {
  it('emits one JSON line carrying a ts and the discriminated fields for every event type', () => {
    for (const event of SAMPLE_EVENTS) {
      const parsed = captureEmit(event)
      expect(typeof parsed.ts).toBe('string')
      expect(new Date(parsed.ts as string).toISOString()).toBe(parsed.ts) // valid ISO timestamp
      // Every field of the source event survives serialization.
      for (const [k, v] of Object.entries(event)) {
        expect(parsed[k]).toEqual(v)
      }
    }
  })

  it('every event shares a stable `type` discriminator and a requestId', () => {
    for (const event of SAMPLE_EVENTS) {
      const parsed = captureEmit(event)
      expect(parsed.type).toBe(event.type)
      expect(parsed.requestId).toBe('r1')
    }
  })
})

describe('PII redaction — HARD requirement', () => {
  it('no emitted payload contains an @, a raw email, or a message-body field', () => {
    for (const event of SAMPLE_EVENTS) {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        emit(event)
        const line = spy.mock.calls[0][0] as string
        expect(line).not.toContain('@')
        const parsed = JSON.parse(line) as Record<string, unknown>
        // None of the forbidden dimensions may appear as keys.
        for (const forbidden of ['content', 'body', 'email', 'text', 'message_content', 'token', 'accessToken']) {
          expect(parsed).not.toHaveProperty(forbidden)
        }
      } finally {
        spy.mockRestore()
      }
    }
  })

  it('hashEmail is non-reversible, fixed-width, and never leaks the address', () => {
    const h = hashEmail('Danny@RxFitATX.com')
    expect(h).toMatch(/^[0-9a-f]{12}$/)
    expect(h).not.toContain('@')
    expect(h).not.toContain('rxfit')
    expect(h).not.toContain('danny')
    // Stable + case/whitespace-normalized.
    expect(hashEmail('  danny@rxfitatx.com ')).toBe(h)
    // Different users → different hashes.
    expect(hashEmail('someone@else.com')).not.toBe(h)
  })
})

describe('startTimer — elapsed-ms monotonicity', () => {
  it('never returns a decreasing value and is non-negative', () => {
    const timer = startTimer()
    let prev = timer()
    expect(prev).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < 1000; i++) {
      // busy work so the monotonic clock advances measurably
      Math.sqrt(i * 7)
      const now = timer()
      expect(now).toBeGreaterThanOrEqual(prev)
      prev = now
    }
  })
})

describe('newRequestId', () => {
  it('returns a unique uuid per call', () => {
    const a = newRequestId()
    const b = newRequestId()
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(a).not.toBe(b)
  })
})

describe('OBSERVABILITY_ENABLED guard', () => {
  const original = process.env.OBSERVABILITY_ENABLED
  beforeEach(() => { delete process.env.OBSERVABILITY_ENABLED })
  afterEach(() => {
    if (original === undefined) delete process.env.OBSERVABILITY_ENABLED
    else process.env.OBSERVABILITY_ENABLED = original
  })

  it('is on by default and only silenced by an explicit "false"', () => {
    expect(observabilityEnabled()).toBe(true)

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      process.env.OBSERVABILITY_ENABLED = 'false'
      expect(observabilityEnabled()).toBe(false)
      emit({ type: 'ai_request_start', requestId: 'x', route: '/api/chat' })
      expect(spy).not.toHaveBeenCalled()

      process.env.OBSERVABILITY_ENABLED = 'true'
      emit({ type: 'ai_request_start', requestId: 'x', route: '/api/chat' })
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})

/* ── NS-10: best-effort DB sink ─────────────────────────────────────────── */

/** Let the sink's fire-and-forget dynamic-import chain settle. */
async function flushSink(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('telemetryDbSinkEnabled — env/test guard matrix', () => {
  const savedFlag = process.env.TELEMETRY_DB_SINK
  const savedNodeEnv = process.env.NODE_ENV
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.TELEMETRY_DB_SINK
    else process.env.TELEMETRY_DB_SINK = savedFlag
    if (savedNodeEnv === undefined) delete (process.env as Record<string, unknown>).NODE_ENV
    else (process.env as Record<string, string>).NODE_ENV = savedNodeEnv
  })

  it('is OFF by default under NODE_ENV=test, and only "on" opts in', () => {
    ;(process.env as Record<string, string>).NODE_ENV = 'test'
    delete process.env.TELEMETRY_DB_SINK
    expect(telemetryDbSinkEnabled()).toBe(false)
    process.env.TELEMETRY_DB_SINK = 'on'
    expect(telemetryDbSinkEnabled()).toBe(true)
    process.env.TELEMETRY_DB_SINK = 'off'
    expect(telemetryDbSinkEnabled()).toBe(false)
  })

  it('is ON by default outside tests, and only an explicit "off" disables it', () => {
    ;(process.env as Record<string, string>).NODE_ENV = 'production'
    delete process.env.TELEMETRY_DB_SINK
    expect(telemetryDbSinkEnabled()).toBe(true)
    process.env.TELEMETRY_DB_SINK = 'off'
    expect(telemetryDbSinkEnabled()).toBe(false)
    process.env.TELEMETRY_DB_SINK = 'anything-else'
    expect(telemetryDbSinkEnabled()).toBe(true)
  })
})

describe('emit — DB sink (fire-and-forget copy into event_log)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  const savedFlag = process.env.TELEMETRY_DB_SINK

  beforeEach(() => {
    recordEventMock.mockClear()
    recordEventMock.mockImplementation(async () => {})
    process.env.TELEMETRY_DB_SINK = 'on' // opt in (NODE_ENV=test defaults OFF)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    logSpy.mockRestore()
    if (savedFlag === undefined) delete process.env.TELEMETRY_DB_SINK
    else process.env.TELEMETRY_DB_SINK = savedFlag
  })

  it('persists ONLY ai_complete / ai_timeout / ai_fallback / ai_error — as telemetry:* rows minus requestId', async () => {
    for (const event of SAMPLE_EVENTS) emit(event)
    await flushSink()

    expect(recordEventMock).toHaveBeenCalledTimes(4)
    const byType = new Map(recordEventMock.mock.calls.map(([opts]) => [opts.eventType, opts]))
    expect([...byType.keys()].sort()).toEqual([
      'telemetry:ai_complete',
      'telemetry:ai_error',
      'telemetry:ai_fallback',
      'telemetry:ai_timeout',
    ])

    const complete = byType.get('telemetry:ai_complete')!
    expect(complete.actor).toBe('system')
    expect(complete.correlationId).toBe('r1') // requestId → correlation_id …
    expect(complete.payload).toEqual({
      type: 'ai_complete',
      ms: 456,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      finishReason: 'stop',
    }) // … and NOT duplicated in the payload
  })

  it('stays synchronous for callers — the stdout line lands before the sink settles', () => {
    emit({ type: 'ai_complete', requestId: 'r9', ms: 10, provider: 'claude', model: 'm' })
    // recordEvent has not resolved yet, but the log line is already out.
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('swallows a rejecting recordEvent — emit neither throws nor loses its stdout line', async () => {
    recordEventMock.mockRejectedValueOnce(new Error('db down'))
    expect(() =>
      emit({ type: 'ai_error', requestId: 'r1', code: 'auth', message: 'boom' }),
    ).not.toThrow()
    await flushSink()
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('swallows a synchronously-throwing recordEvent too', async () => {
    recordEventMock.mockImplementationOnce(() => {
      throw new Error('sync boom')
    })
    expect(() =>
      emit({ type: 'ai_timeout', requestId: 'r1', layer: 'idle', provider: 'gemini', model: 'm' }),
    ).not.toThrow()
    await flushSink()
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('does not touch the DB when the sink is not opted in under test (default guard)', async () => {
    delete process.env.TELEMETRY_DB_SINK
    emit({ type: 'ai_complete', requestId: 'r1', ms: 1, provider: 'claude', model: 'm' })
    await flushSink()
    expect(recordEventMock).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledTimes(1) // stdout is unaffected by the sink guard
  })

  it('does not touch the DB when TELEMETRY_DB_SINK=off', async () => {
    process.env.TELEMETRY_DB_SINK = 'off'
    emit({ type: 'ai_error', requestId: 'r1', code: 'x', message: 'y' })
    await flushSink()
    expect(recordEventMock).not.toHaveBeenCalled()
  })

  it('emits nothing at all (stdout or DB) when observability is disabled entirely', async () => {
    process.env.OBSERVABILITY_ENABLED = 'false'
    try {
      emit({ type: 'ai_complete', requestId: 'r1', ms: 1, provider: 'claude', model: 'm' })
      await flushSink()
      expect(logSpy).not.toHaveBeenCalled()
      expect(recordEventMock).not.toHaveBeenCalled()
    } finally {
      delete process.env.OBSERVABILITY_ENABLED
    }
  })
})
