import { describe, it, expect } from 'vitest'
import { parseTraceparent, gcpTraceFields } from './trace-context'

/* ════════════════════════════════════════════════════════════════════════════
   traceparent parsing (lib/trace-context.ts, Layer 0) — the field that nests
   the app's log lines under the Cloud Run request log. Malformed input must
   yield null (no correlation), never garbage field values.
   ════════════════════════════════════════════════════════════════════════════ */

const TRACE = '0af7651916cd43dd8448eb211c80319c'
const SPAN = 'b7ad6b7169203331'

describe('parseTraceparent', () => {
  it('parses a well-formed version-00 header', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({ traceId: TRACE, spanId: SPAN })
  })

  it('normalizes case and surrounding whitespace', () => {
    expect(parseTraceparent(`  00-${TRACE.toUpperCase()}-${SPAN.toUpperCase()}-01 `)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
    })
  })

  it('tolerates a future version appending fields after the flags', () => {
    // The regex anchors on `-` OR end after flags; version 00 itself must
    // still match when a proxy appends vendor data.
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01-extra`)).toEqual({ traceId: TRACE, spanId: SPAN })
  })

  it('rejects the spec-invalid all-zero ids', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN}-01`)).toBeNull()
    expect(parseTraceparent(`00-${TRACE}-${'0'.repeat(16)}-01`)).toBeNull()
  })

  it('rejects everything malformed', () => {
    expect(parseTraceparent(null)).toBeNull()
    expect(parseTraceparent('')).toBeNull()
    expect(parseTraceparent('not-a-traceparent')).toBeNull()
    expect(parseTraceparent(`00-${TRACE}-${SPAN}`)).toBeNull() // flags missing
    expect(parseTraceparent(`00-${TRACE.slice(1)}-${SPAN}-01`)).toBeNull() // short trace
    // The legacy X-Cloud-Trace-Context shape must not half-parse (its span is
    // DECIMAL — the whole reason traceparent is preferred).
    expect(parseTraceparent(`${TRACE}/8355936;o=1`)).toBeNull()
  })
})

describe('gcpTraceFields', () => {
  it('emits the two Cloud Logging keys for a parsed trace', () => {
    const fields = gcpTraceFields({ traceId: TRACE, spanId: SPAN })
    expect(fields['logging.googleapis.com/trace']).toMatch(new RegExp(`^projects/[\\w-]+/traces/${TRACE}$`))
    expect(fields['logging.googleapis.com/spanId']).toBe(SPAN)
  })

  it('is an empty object for null — always spread-safe', () => {
    expect(gcpTraceFields(null)).toEqual({})
  })
})
