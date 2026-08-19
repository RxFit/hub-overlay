import type { ChatMessage } from '@/types'
import type { SystemPromptParts } from './claude'
import { CONNECT_TIMEOUT_MS } from './timeout-config'
import { emit, type AiProvider } from './observability'
import { recordAiRun } from './runs'
import {
  agyErrorType,
  agyGenerateText,
  isAgyBinaryReady,
  isAgyConfigured,
  truncateAgyError,
  warmAgyBinary,
} from './agy'
import { dispatchGenerateText, isDispatchConfigured, isDispatchEnabled } from './agy-dispatch'

/** Dispatch-layer availability failures — cheap to detect per turn, so they
 *  fall through without cooling the allotment path (unlike run failures). */
const DISPATCH_AVAILABILITY_CLASSES = new Set(['no_worker', 'queue_full', 'claim_timeout', 'lease_expired'])

/**
 * lib/agy-chat.ts — Phase 2 of the agy execution gateway: chat traffic on the
 * subscription allotment.
 *
 * Phase 1 (lib/agy.ts + /api/admin/agy-health) proved a desktop-minted token
 * replays headless on Cloud Run. This module puts that to work: when the
 * operator flips AGY_CHAT_ENABLED, non-EXA chat turns try the allotment FIRST
 * and only fall through to the metered Gemini chain when agy can't serve.
 * That ordering is the whole point — every turn agy serves costs zero API
 * spend — but it is guarded so the gateway can only ever ADD a bounded delay,
 * never break chat:
 *
 *  - OPT-IN. Default off; the flag is flipped per-environment after the
 *    agy-health probe is green (docs/runbooks/agy-gateway.md § Phase 2).
 *  - EXA mode is excluded. The EXA toggle routes to Claude Fable 5 by
 *    operator decision (see shouldUseClaude in lib/gemini.ts) — research
 *    synthesis is not moved onto an undocumented gateway.
 *  - NO cold-start install on an interactive turn. The ~55MB download +
 *    ~206MB extract happens in the background (warmAgyBinary); until the
 *    binary is ready, turns serve from Gemini as if the flag were off.
 *  - BOUNDED attempt. One run, capped at AGY_CHAT_TIMEOUT_MS (default: the
 *    45s CONNECT_TIMEOUT_MS per-attempt rung of the timeout ladder), leaving
 *    the Gemini chain most of the 110s client budget on failure.
 *  - FAIL-SAFE rotation. agy output arrives atomically at the END of its run,
 *    so a failure never leaves partial tokens on the wire — unlike a
 *    mid-stream provider failure, falling through to Gemini is ALWAYS safe.
 *    tryAgyChat therefore never throws; it reports 'fallthrough'.
 *  - COOLDOWN so a broken gateway doesn't tax every request: auth-class
 *    failures (dead token) cool 30 min, everything else 5 min — the same
 *    tiers as the Gemini/Claude chains in lib/gemini.ts.
 *
 * The standing caveat from the runbook applies: this rides undocumented
 * upstream behavior. If it degrades permanently, unset AGY_CHAT_ENABLED and
 * chat is byte-identical to pre-Phase-2.
 */

const AGY_DISPLAY_NAME = 'Antigravity'

/* ── Cooldown (mirrors the tiers in lib/gemini.ts, kept module-local so this
   file has no dependency on gemini.ts internals and no import cycle) ── */
let cooldown: { failedAt: number; cooldownMs: number } | null = null

function recordAgyChatFailure(isAuth: boolean): void {
  cooldown = { failedAt: Date.now(), cooldownMs: isAuth ? 1_800_000 : 300_000 }
}

function isAgyChatInCooldown(): boolean {
  if (!cooldown) return false
  if (Date.now() - cooldown.failedAt > cooldown.cooldownMs) {
    cooldown = null
    return false
  }
  return true
}

/** TEST-ONLY: clear the cooldown between cases (same pattern as
 *  __resetModelCooldownsForTest in lib/gemini.ts). */
export function __resetAgyChatCooldownForTest(): void {
  cooldown = null
}

/** Operator opt-in: AGY_CHAT_ENABLED=true (or 1) AND a credential present. */
export function isAgyChatEnabled(): boolean {
  const flag = process.env.AGY_CHAT_ENABLED
  if (flag !== 'true' && flag !== '1') return false
  // The "configured" check follows the transport: local execution needs the
  // OAuth token on this machine; desktop dispatch (Phase 2.5) needs only the
  // worker credential — the token stays on the desktop, which is the point.
  return isDispatchEnabled() ? isDispatchConfigured() : isAgyConfigured()
}

/**
 * Should this turn attempt the allotment? Enabled, not EXA (Fable 5's lane),
 * and not cooling down from a recent failure.
 */
export function shouldTryAgyChat(useCase: string): boolean {
  return isAgyChatEnabled() && useCase !== 'exa_search' && !isAgyChatInCooldown()
}

/** Attempt ceiling — clamped so a slow run can't eat the client's whole
 *  110s budget (CLIENT_ABORT_MS) and starve the Gemini fallback. */
export function agyChatTimeoutMs(): number {
  const raw = Number(process.env.AGY_CHAT_TIMEOUT_MS)
  if (!Number.isFinite(raw) || raw <= 0) return CONNECT_TIMEOUT_MS
  return Math.min(Math.max(raw, 5_000), 90_000)
}

/**
 * Flatten the chat request into agy's single-prompt form. The CLI has no
 * system/history separation, so the system text leads, the transcript follows
 * with explicit role labels, and the final line pins what to answer. Pure and
 * exported for direct testing.
 */
export function buildAgyPrompt(messages: ChatMessage[], systemText: string): string {
  const transcript = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
  return (
    `${systemText}\n\n` +
    `# Conversation\n${transcript}\n\n` +
    `Respond as the Assistant to the last User message above. Output ONLY the reply text.`
  )
}

/* Local copy of gemini.ts's sysText, for the same reason it is local there:
   importing it would force every test that mocks a provider module to also
   provide it. */
function sysText(sp: string | SystemPromptParts): string {
  return typeof sp === 'string' ? sp : sp.staticPrefix + sp.dynamic
}

/** Structural slice of gemini.ts's ObsCtx — enough to attribute telemetry. */
export interface AgyObsCtx {
  requestId: string
  timer: () => number
  attempt: number
  provider?: AiProvider
  model?: string
}

/**
 * One bounded allotment attempt. Yields the modelUsed badge, then (on
 * success) the full answer as a single chunk. Returns 'served' when agy
 * answered (or the client aborted — terminal either way) and 'fallthrough'
 * when the caller should continue to the Gemini chain. NEVER throws: agy
 * emits nothing until its run completes, so no failure here can leave a
 * partial answer on the wire.
 */
export async function* tryAgyChat(
  messages: ChatMessage[],
  systemPrompt: string | SystemPromptParts,
  obs: AgyObsCtx,
  signal: AbortSignal | undefined,
  fallbackTo: string,
): AsyncGenerator<string | { modelUsed: string }, 'served' | 'fallthrough'> {
  if (signal?.aborted) return 'served'

  // Cold instance: provision in the background, serve this turn from Gemini.
  // Dispatch mode skips this entirely — the desktop runs the binary, and
  // warming a ~206MB binary Cloud Run will never execute is pure waste.
  if (!isDispatchEnabled() && !isAgyBinaryReady()) {
    warmAgyBinary()
    console.info('[agy-chat] binary not provisioned yet — warming in background, serving from the metered chain')
    return 'fallthrough'
  }

  obs.provider = 'agy'
  obs.model = 'agy'
  obs.attempt += 1
  emit({ type: 'ai_provider_selected', requestId: obs.requestId, provider: 'agy', model: 'agy', attempt: obs.attempt })
  yield { modelUsed: AGY_DISPLAY_NAME }

  const prompt = buildAgyPrompt(messages, sysText(systemPrompt))
  const started = Date.now()
  try {
    // The Phase 2.5 transport switch: same AgyResult shape, same typed-error
    // contract, so everything below (ledger, cooldown tiers, fallback) is
    // transport-agnostic.
    const result = isDispatchEnabled()
      ? await dispatchGenerateText(prompt, {
          budgetMs: agyChatTimeoutMs(),
          requestId: obs.requestId,
          signal,
        })
      : await agyGenerateText(prompt, {
          timeoutMs: agyChatTimeoutMs(),
        })
    // Ledger write is fire-and-forget: recordAiRun is internally best-effort
    // and must not add latency between the answer arriving and it reaching
    // the wire. Recorded even when the client aborted below — the allotment
    // was spent either way, and the ledger's job is to say so.
    const dispatchRaw = result.raw as { dispatch?: boolean; jobId?: string; workerId?: string } | null
    void recordAiRun({
      engine: 'agy',
      model: result.model,
      source: 'chat',
      status: 'ok',
      latencyMs: result.latencyMs,
      prompt,
      usage: result.usage,
      requestId: obs.requestId,
      meta: dispatchRaw?.dispatch
        ? { dispatch: true, jobId: dispatchRaw.jobId, workerId: dispatchRaw.workerId }
        : undefined,
    })
    // Client gave up while the run was in flight: stop quietly (terminal), the
    // same contract as the Claude/Gemini abort paths — nothing is restarted.
    if (signal?.aborted) return 'served'
    yield result.text
    return 'served'
  } catch (err) {
    const type = agyErrorType(err)
    void recordAiRun({
      engine: 'agy',
      source: 'chat',
      status: 'error',
      errorClass: type,
      error: truncateAgyError(err),
      latencyMs: Date.now() - started,
      prompt,
      requestId: obs.requestId,
    })
    if (signal?.aborted) return 'served'
    // Dispatch AVAILABILITY classes never cool down: their detection is
    // already cheap and self-limiting (~5ms liveness gate, ≤5s claim window,
    // fail-fast lease check), and cooling would blind the Hub to the worker's
    // return for 5 minutes for no saving — the design forbids exactly that
    // (DESKTOP_DISPATCH §5, failure row 1: "no cooldown to wait out").
    // A dead token can't heal in minutes; not_configured means the env var
    // vanished — both get the long auth tier. Everything else (timeout,
    // empty, parse, install, spawn) is the 5-min real-failure tier.
    if (!DISPATCH_AVAILABILITY_CLASSES.has(type)) {
      recordAgyChatFailure(type === 'auth' || type === 'not_configured')
    }
    emit({
      type: 'ai_fallback',
      requestId: obs.requestId,
      from: 'agy',
      to: fallbackTo,
      reason: type === 'auth' || type === 'not_configured' ? 'auth' : type,
    })
    console.warn(`[agy-chat] allotment attempt failed (${type}) — falling through to the metered chain:`, truncateAgyError(err))
    return 'fallthrough'
  }
}
