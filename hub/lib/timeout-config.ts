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
 *        <= CLIENT_ABORT_MS (110s)  browser AbortController on fetch('/api/chat')
 *                                   — the user-facing ceiling. Sized for
 *                                   thinking-first models (Fable 5 can think
 *                                   30-60s before its first token on research
 *                                   turns); progress is still guarded by the
 *                                   30s idle watchdog + thinking heartbeats
 *        <  ROUTE_MAX_DURATION_MS (120s) platform request cap
 *                                   (Next `maxDuration`, Cloud Run/Railway)
 *
 * Rationale for each rung:
 *  - IDLE < CONNECT: a mid-stream stall should be caught by the idle watchdog
 *    (30s) well before any per-attempt ceiling, and torn down cleanly.
 *  - CONNECT <= CLIENT: the server's own per-attempt protection must not exceed
 *    the client's patience — otherwise the client abandons the request while the
 *    server keeps burning compute on work no one is waiting for. The client bound
 *    is deliberately larger than CONNECT: connecting must be fast (45s), but a
 *    connected, heartbeat-alive stream (thinking models) may legitimately run
 *    ~2 minutes before completing.
 *  - CLIENT < ROUTE_MAX_DURATION: the browser gives up (and the server tears the
 *    stream down) long before the hard platform cap, so we never rely on the
 *    platform killing a runaway request.
 *
 * ── The pre-stream rung (context assembly, /api/chat) ──
 * Before the model is even contacted, the EXA path assembles context from three
 * independent backends. Those bounds used to live as inline literals in
 * app/api/chat/route.ts and lib/vertex.ts, OUTSIDE this module — which is exactly
 * how the Vertex branch came to hold an INNER bound of 10s under an OUTER bound
 * of 8s. The inner abort could never fire before its caller had already given up,
 * so a timed-out search left an orphaned request running. Pulling these in puts
 * them under the same invariant test as the rest of the ladder:
 *
 *   VERTEX_SEARCH_MS (8s)          per Discovery Engine :search call (lib/vertex.ts)
 *        <= EXA_VERTEX_BRANCH_MS (8s)   caller bound on the Vertex branch
 *   ATTACHMENT_VERTEX_MS (6s)      attachment-resolver's own, tighter bound
 *   EXA_QUERY_PLANNER_MS (2.5s)    serial head latency inside the Exa branch
 *        <  EXA_SEARCH_BRANCH_MS (30s)  caller bound on the whole Exa branch
 *
 * PRE_STREAM_MAX_MS is the worst case of the three branches run concurrently.
 * It is held strictly under CLIENT_ABORT_MS so that assembly cannot, on its own,
 * consume the user's entire patience before a provider is ever dialled.
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
export const CLIENT_ABORT_MS = 110_000

/** Platform request cap; mirrors `export const maxDuration = 120` in route.ts. */
export const ROUTE_MAX_DURATION_MS = 120_000

/* ── Pre-stream context assembly (EXA path, app/api/chat/route.ts) ── */

/**
 * Per Discovery Engine `:search` call (AbortSignal in lib/vertex.ts).
 *
 * MUST stay <= EXA_VERTEX_BRANCH_MS. When this was 10s against an 8s caller
 * bound the inner abort was unreachable by construction: `withTimeout` resolved
 * its fallback at 8s and the fetch kept running, unobserved, for 2s more.
 */
export const VERTEX_SEARCH_MS = 8_000

/** Caller bound on the Vertex branch of the EXA pre-stream Promise.all. */
export const EXA_VERTEX_BRANCH_MS = 8_000

/**
 * Attachment resolution queries Vertex with its own, tighter bound, so it passes
 * an explicit signal rather than taking the VERTEX_SEARCH_MS default.
 */
export const ATTACHMENT_VERTEX_MS = 6_000

/**
 * The Gemini query-decomposition planner that runs BEFORE the Exa search is
 * issued. This is strictly serial head latency on the branch that gates the
 * whole response, and its failure-open path costs the full bound before falling
 * back to the raw query — so the cap is deliberately tight. Exa's `deep` tier
 * already runs its own multi-agent fan-out and `useAutoprompt` is already on,
 * so a slow planner buys little that is worth seconds of dead time.
 */
export const EXA_QUERY_PLANNER_MS = 2_500

/** Caller bound on the whole Exa branch (planner + deep tier + fallback fan-out). */
export const EXA_SEARCH_BRANCH_MS = 30_000

/** Caller bound on the Drive-link branch. Inert in practice: resolveDriveLinkContext
 * returns before any I/O when the message carries no Drive link. */
export const DRIVE_LINKS_BRANCH_MS = 12_000

/**
 * Worst-case pre-stream context assembly: the three EXA branches run
 * concurrently, so the bound is the slowest of them, not their sum.
 */
export const PRE_STREAM_MAX_MS = Math.max(
  EXA_SEARCH_BRANCH_MS,
  EXA_VERTEX_BRANCH_MS,
  DRIVE_LINKS_BRANCH_MS,
)
