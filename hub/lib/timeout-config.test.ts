import { describe, it, expect } from 'vitest'
import {
  GOOGLE_API_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  CLIENT_ABORT_MS,
  ROUTE_MAX_DURATION_MS,
} from './timeout-config'

/**
 * Locks the timeout ladder ordering (see lib/timeout-config.ts). If a future edit
 * makes an inner timeout exceed an outer one — e.g. the connect ceiling creeping
 * back above the client abort, or the client outliving the platform cap — these
 * assertions fail, catching the skew before it can strand or prematurely kill a
 * legitimately slow stream.
 */
describe('timeout ladder ordering invariant', () => {
  it('is monotonic from innermost per-call bound out to the platform cap', () => {
    // Innermost: a single upstream Google REST call must resolve/abort well
    // before the per-chunk idle watchdog would fire.
    expect(GOOGLE_API_TIMEOUT_MS).toBeLessThan(IDLE_TIMEOUT_MS)

    // A mid-stream stall is caught by the idle watchdog before the per-attempt
    // connect/request ceiling.
    expect(IDLE_TIMEOUT_MS).toBeLessThan(CONNECT_TIMEOUT_MS)

    // The server's per-attempt ceiling must never exceed the client's patience —
    // otherwise the browser abandons the request while the server keeps working.
    expect(CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(CLIENT_ABORT_MS)

    // The client (and the server stream teardown it triggers) gives up well
    // before the hard platform request cap.
    expect(CLIENT_ABORT_MS).toBeLessThan(ROUTE_MAX_DURATION_MS)
    expect(CONNECT_TIMEOUT_MS).toBeLessThan(ROUTE_MAX_DURATION_MS)
  })

  it('keeps the idle watchdog strictly inside the client abort so server-side protection fires first', () => {
    // The key alignment guarantee: the server's own idle protection kicks in
    // before the client gives up, so a stalled stream is torn down cleanly rather
    // than being abandoned by the client with the server still hanging.
    expect(IDLE_TIMEOUT_MS).toBeLessThan(CLIENT_ABORT_MS)
  })

  it('uses positive, finite millisecond values', () => {
    for (const v of [GOOGLE_API_TIMEOUT_MS, IDLE_TIMEOUT_MS, CONNECT_TIMEOUT_MS, CLIENT_ABORT_MS, ROUTE_MAX_DURATION_MS]) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
  })
})
