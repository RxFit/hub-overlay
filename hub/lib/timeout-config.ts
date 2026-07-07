/**
 * Timeout ladder — single source of truth for the layered timeouts that guard
 * the chat/streaming path. Kept in ONE dependency-free module so the values are
 * co-located, imported by both client and server, and locked by an ordering
 * invariant test (see timeout-config.test.ts).
 *
 * ── Why these values are ordered the way they are ──
 * A request must never hang past the OUTERMOST bound, and no INNER timeout may
 * fire so early that it kills a legitimately slow-but-progressing stream. The
 * ladder is therefore monotonic from the innermost per-call bound out to the
 * platform request ceiling:
 *
 *   GOOGLE_API_TIMEOUT_MS (10s)   per upstream Google REST call (lib/google.ts)
 *        <  IDLE_TIMEOUT_MS (30s)   per-chunk stall watchdog on a live model
 *                                   stream (withIdleWatchdog, both providers)
 *        <  CONNECT_TIMEOUT_MS (45s) per-attempt ceiling to OPEN a provider
 *                                   stream / complete a provider request
 *                                   (Gemini connect race + Claude fetch abort)
 *        <= CLIENT_ABORT_MS (45s)   browser AbortController on fetch('/api/chat')
 *                                   — the user-facing ceiling
 *        <  ROUTE_MAX_DURATION_MS (120s) platform request cap
 *                                   (Next `maxDuration`, Cloud Run/Railway)
 *
 * Rationale for each rung:
 *  - IDLE < CONNECT: a mid-stream stall should be caught by the idle watchdog
 *    (30s) well before any per-attempt ceiling, and torn down cleanly.
 *  - CONNECT <= CLIENT: the server's own per-attempt protection must not exceed
 *    the client's patience — otherwise the client abandons the request while the
 *    server keeps burning compute on work no one is waiting for. Gemini's connect
 *    race and Claude's request abort both sit at 45s so the two providers behave
 *    identically and both stay at/under the client bound.
 *  - CLIENT < ROUTE_MAX_DURATION: the browser gives up (and the server tears the
 *    stream down) long before the hard platform cap, so we never rely on the
 *    platform killing a runaway request.
 *
 * If you change any value, keep the chain monotonic — the invariant test will
 * fail otherwise. NOTE: route.ts declares `export const maxDuration = 120` as a
 * literal because Next.js reads it via static analysis (an imported constant is
 * not statically analyzable); ROUTE_MAX_DURATION_MS mirrors it for the test.
 */

/** Per upstream Google REST call (AbortSignal.timeout in lib/google.ts). */
export const GOOGLE_API_TIMEOUT_MS = 10_000

/**
 * Per-chunk idle watchdog on a live model stream (withIdleWatchdog). A connected
 * stream that then stalls mid-flight is torn down after this long with no output.
 */
export const IDLE_TIMEOUT_MS = 30_000

/**
 * Per-attempt ceiling to open a provider stream (Gemini `sendMessageStream`
 * connect race) or complete a Claude request (fetch AbortController). Held at or
 * under CLIENT_ABORT_MS so the server never outlives the client that is waiting.
 */
export const CONNECT_TIMEOUT_MS = 45_000

/** Browser-side AbortController on fetch('/api/chat') — the user-facing ceiling. */
export const CLIENT_ABORT_MS = 45_000

/** Platform request cap; mirrors `export const maxDuration = 120` in route.ts. */
export const ROUTE_MAX_DURATION_MS = 120_000
