import { describe, it, expect } from 'vitest'
import {
  GOOGLE_API_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  CLIENT_ABORT_MS,
  ROUTE_MAX_DURATION_MS,
  VERTEX_SEARCH_MS,
  EXA_VERTEX_BRANCH_MS,
  ATTACHMENT_VERTEX_MS,
  EXA_QUERY_PLANNER_MS,
  EXA_SEARCH_BRANCH_MS,
  DRIVE_LINKS_BRANCH_MS,
  PRE_STREAM_MAX_MS,
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

/**
 * Locks the PRE-STREAM rung (context assembly before the model is dialled).
 *
 * These bounds lived as inline literals in app/api/chat/route.ts and
 * lib/vertex.ts, so no invariant covered them — which is how the Vertex branch
 * came to hold a 10s inner bound beneath an 8s outer bound. The first assertion
 * below is the one that would have caught it.
 */
describe('pre-stream context assembly invariant', () => {
  it('keeps every inner search bound at or under its caller bound', () => {
    // THE regression guard: a per-call Discovery Engine bound above its caller's
    // branch bound is unreachable by construction — withTimeout resolves the
    // fallback first and the fetch keeps running unobserved.
    expect(VERTEX_SEARCH_MS).toBeLessThanOrEqual(EXA_VERTEX_BRANCH_MS)

    // Attachment resolution bounds Vertex tighter than the chat path, so it must
    // pass an explicit signal rather than inherit the (larger) default.
    expect(ATTACHMENT_VERTEX_MS).toBeLessThanOrEqual(VERTEX_SEARCH_MS)

    // The planner is serial head latency INSIDE the Exa branch, so it has to fit
    // strictly within that branch with room left for the search itself.
    expect(EXA_QUERY_PLANNER_MS).toBeLessThan(EXA_SEARCH_BRANCH_MS)
  })

  it('derives the pre-stream worst case from the slowest concurrent branch', () => {
    // Promise.all settles on the slowest branch — the bound is a max, not a sum.
    expect(PRE_STREAM_MAX_MS).toBe(
      Math.max(EXA_SEARCH_BRANCH_MS, EXA_VERTEX_BRANCH_MS, DRIVE_LINKS_BRANCH_MS),
    )
  })

  it('cannot consume the client budget on assembly alone, even before a provider is dialled', () => {
    // Assembly then a provider connect must both fit inside the user's patience,
    // otherwise the browser aborts a request the server is still setting up.
    expect(PRE_STREAM_MAX_MS).toBeLessThan(CLIENT_ABORT_MS)
    expect(PRE_STREAM_MAX_MS + CONNECT_TIMEOUT_MS).toBeLessThan(CLIENT_ABORT_MS)
  })

  it('uses positive, finite millisecond values', () => {
    for (const v of [
      VERTEX_SEARCH_MS,
      EXA_VERTEX_BRANCH_MS,
      ATTACHMENT_VERTEX_MS,
      EXA_QUERY_PLANNER_MS,
      EXA_SEARCH_BRANCH_MS,
      DRIVE_LINKS_BRANCH_MS,
      PRE_STREAM_MAX_MS,
    ]) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
  })
})
