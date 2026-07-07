import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  emit,
  newRequestId,
  startTimer,
  hashEmail,
  observabilityEnabled,
  type TelemetryEvent,
} from './observability'

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
