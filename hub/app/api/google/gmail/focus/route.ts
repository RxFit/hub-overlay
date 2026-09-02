import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse, googleRouteCtx } from '@/lib/google-session'
import { listRecentGmailThreads } from '@/lib/google'
import { clampInt } from '@/lib/num'
import {
  buildFocusPrompt,
  parseFocusRanking,
  scoreFocusItems,
  seededOrder,
  threadsSignature,
  getCachedFocus,
  setCachedFocus,
  type FocusItem,
  type FocusRankEntry,
} from '@/lib/gmail-focus'
import { extractThreadSignals, DEFAULT_MIN_PRIORITY } from '@/lib/gmail-signals'
import { claudeChat, isClaudeConfigured } from '@/lib/claude'
import { withTimeout } from '@/lib/timeout'
import { recordAiAction } from '@/lib/ai-audit'
import { newRequestId } from '@/lib/observability'
import { geminiGenerateText } from '@/lib/gemini'
import { focusPreferencesSignature, EMPTY_FOCUS_PREFERENCES } from '@/lib/focus-preferences'
import { getFocusPreferences } from '@/lib/focus-preferences-db'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'
export const maxDuration = 30

/* ══════════════════════════════════════════════════════════════════════════════
   GMAIL FOCUS QUEUE
   GET /api/google/gmail/focus

   AI-ranked "handle these first" strip for the Gmail view. Reads inbox thread
   METADATA (never bodies), asks Gemini for the top threads worth the user's
   attention, and returns hardened { items: FocusItem[] }.

   - READ-ONLY: this route performs no Gmail writes, so no gate token is
     required (gate tokens guard AI-originated WRITES — see requireAiGate on
     the send route). Any future "act on this suggestion" send still goes
     through the existing gate-token + audit path on POST /api/google/gmail.
   - AUDITED: every FRESH model ranking (not cache hits) writes one
     `gmail_focus_rank` row via recordAiAction — metadata only (thread count,
     model), never subjects/snippets.
   - CACHED: per-user in-memory cache keyed by the thread-list signature with a
     TTL, so the client's poll doesn't become a model call per poll.
   - FAIL-OPEN: ranking is advisory. Model outage returns { items: [] } with
     degraded: true; the client simply hides the strip.
   ══════════════════════════════════════════════════════════════════════════════ */

const CACHE_TTL_MS = 10 * 60 * 1000
/* An empty ranking is cached only briefly: it is far more often a transient
   model hiccup (empty/truncated output) than a genuine "nothing matters"
   verdict, and a 10-minute empty cache reads as "the feature is broken". */
const EMPTY_CACHE_TTL_MS = 2 * 60 * 1000
const FOCUS_THREAD_POOL = 20

/* Time budget. The old single 20s cap covered a THREE-model sequential chain
   with no per-model bound, against a non-streaming call on a thinking-by-default
   model — so one slow first model could consume the whole budget and models 2
   and 3 never ran. Per-model bound x 3 now fits inside the total, which itself
   sits under `maxDuration = 30`. */
const PER_MODEL_TIMEOUT_MS = 8_000
const RANK_BUDGET_MS = 24_000
const PREFS_TIMEOUT_MS = 3_000

const FOCUS_SYSTEM_PROMPT =
  'You are an inbox triage assistant. Follow the instructions in the user message exactly and respond with ONLY the requested JSON array — no markdown, no prose.'

/* The one Gemini call in the app whose entire contract is "return JSON" was
   also the only one not asking for JSON. Every other structured call site sets
   this. */
const FOCUS_GENERATION_CONFIG = { responseMimeType: 'application/json', temperature: 0 }

/**
 * Rank with Gemini, falling back to Claude.
 *
 * Focus was the last AI path in the app without cross-provider failover. Chat,
 * intent detection and tool planning all gained one after the same failure —
 * the Gemini chain down or in cooldown — reached production (see the war story
 * in lib/ai-tools/plan.ts). Without it, any transient Gemini problem pins the
 * strip to its deterministic fallback indefinitely, which is exactly what the
 * user was looking at.
 */
async function rankWithFallback(prompt: string): Promise<{ text: string; model: string }> {
  try {
    return await geminiGenerateText(FOCUS_SYSTEM_PROMPT, prompt, {
      generationConfig: FOCUS_GENERATION_CONFIG,
      perModelTimeoutMs: PER_MODEL_TIMEOUT_MS,
    })
  } catch (geminiErr) {
    if (!isClaudeConfigured()) throw geminiErr
    console.warn('[gmail-focus] Gemini ranking unavailable — falling back to Claude:', geminiErr)
    const text = await claudeChat(
      [{ id: 'focus-rank', role: 'user', content: prompt, timestamp: '' }],
      FOCUS_SYSTEM_PROMPT,
      { maxTokens: 2048, temperature: 0 },
    )
    return { text, model: 'claude-fallback' }
  }
}


export const GET = withFault('google/gmail/focus', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  const userEmail = session.user.email ?? 'user'
  const maxResults = clampInt(req.nextUrl.searchParams.get('maxResults'), FOCUS_THREAD_POOL, 5, 50)

  let threads
  try {
    threads = await listRecentGmailThreads(auth.accessToken, { maxResults, userEmail })
  } catch (err) {
    return googleApiErrorResponse(err, googleRouteCtx(req, '/api/google/gmail/focus'))
  }

  if (threads.length === 0) {
    return NextResponse.json({ items: [], generatedAt: new Date().toISOString(), cached: false })
  }

  // Per-user personalization (VIP list + goals). FAIL-OPEN: an outage or an
  // empty row returns EMPTY prefs, so ranking degrades to the pre-feature
  // behavior instead of failing the request.
  // A catch is not a timeout: the DB helper swallows errors, but a hung socket
  // would still block the whole route ahead of an already-tight AI budget.
  const prefs = await withTimeout(
    getFocusPreferences(userEmail),
    PREFS_TIMEOUT_MS,
    EMPTY_FOCUS_PREFERENCES,
    'focus-prefs',
  )

  // Deterministic signals for every thread — the global model. Computed once
  // and shared by the prompt, the scorer and the reason builder so all three
  // agree on what kind of sender each thread is.
  const signals = new Map(
    threads.map(t => [t.id, extractThreadSignals(t, { userEmail, vips: prefs.vips })]),
  )

  // Display enrichment for notifications: sender/subject come from the LIVE
  // Gmail thread data (already fetched above), never from model output — the
  // same trust posture as the FocusStrip's display join. Items whose thread
  // left the list simply carry no display fields.
  const threadById = new Map(threads.map(t => [t.id, t]))
  const enrich = (list: FocusItem[]) =>
    list.map(i => {
      const t = threadById.get(i.id)
      return t ? { ...i, from: t.from, subject: t.subject } : i
    })

  // Serve from cache while the inbox composition AND the preferences are
  // unchanged and fresh — editing VIPs/goals must invalidate a cached ranking.
  const signature = `${threadsSignature(threads)}#${focusPreferencesSignature(prefs)}`
  const cached = getCachedFocus(userEmail, signature)
  if (cached) {
    return NextResponse.json({
      items: enrich(cached.items),
      generatedAt: cached.generatedAt,
      cached: true,
      model: cached.model,
      degraded: cached.degraded,
    })
  }

  // Fresh ranking — audited (metadata only, NS-2 shape), fail-open on error.
  const auditBase = {
    userEmail: session.user.email ?? null,
    actor: 'ai' as const,
    actionType: 'gmail_focus_rank' as const,
    target: { threadCount: threads.length },
    intent: 'Prioritized inbox focus queue',
    gateToken: null,
    requestId: newRequestId(),
  }

  // ── AI ranking with a hard time budget, deterministic scoring either way ──
  // The model no longer produces the final number: it labels every thread with
  // a level and quotes the text justifying it, and scoreFocusItems blends that
  // with the deterministic score under the sender class's hard ceiling. So a
  // total AI outage degrades the ranking (deterministic only) rather than
  // switching to a different algorithm.
  let model = 'deterministic'
  let aiFailure: string | null = null
  // True once the model returns a VALID ranking — even an all-"none" one. A
  // genuine "nothing matters" verdict must be honored, not treated as failure.
  let aiRanked = false
  let entries: ReadonlyMap<string, FocusRankEntry> | null = null
  try {
    const prompt = buildFocusPrompt(userEmail, threads, prefs, signals, {
      order: seededOrder(threads.length, signature),
    })
    const ranked = await withTimeout(rankWithFallback(prompt), RANK_BUDGET_MS, null, 'gmail-focus-rank')
    if (ranked) {
      const result = parseFocusRanking(ranked.text, threads)
      if (result.parsed) {
        aiRanked = true
        entries = result.entries
        model = ranked.model
      } else {
        aiFailure = 'unparseable model output'
      }
    } else {
      aiFailure = `rank timeout (${RANK_BUDGET_MS / 1000}s)`
    }
  } catch (err) {
    aiFailure = err instanceof Error ? err.message.slice(0, 200) : 'unknown error'
  }

  const items = scoreFocusItems(threads, signals, entries, { minPriority: DEFAULT_MIN_PRIORITY })

  const generatedAt = new Date().toISOString()
  setCachedFocus(userEmail, {
    signature,
    // Key the SHORT ttl on what the constant's own comment describes: a
    // degraded or empty result is far more often a transient hiccup than a
    // verdict, and should be retried soon. (This previously keyed on the model
    // name, so a valid-but-empty AI ranking — the case the comment was written
    // to prevent — got the full 10 minutes.)
    expiresAt: Date.now() + (!aiRanked || items.length === 0 ? EMPTY_CACHE_TTL_MS : CACHE_TTL_MS),
    generatedAt,
    model,
    degraded: !aiRanked,
    items,
  })

  // Audit off the response path — it cannot throw (ai-audit catches), but a
  // slow insert should not delay every poll.
  void withTimeout(
    recordAiAction({
      ...auditBase,
      // A failure means the AI never produced a valid ranking. A valid verdict
      // in which nothing cleared the bar is a success.
      status: aiFailure ? 'failed' : 'success',
      target: { ...auditBase.target, model, itemCount: items.length },
      ...(aiFailure ? { error: aiFailure } : {}),
    }),
    2_000,
    undefined,
    'focus-audit',
  )

  return NextResponse.json({
    items: enrich(items),
    generatedAt,
    cached: false,
    model,
    // The route's contract has always promised this flag; it was never
    // implemented, so a total ranking outage rendered as working AI ranking
    // under an "AI-suggested priorities" label. That is why this stayed broken
    // long enough to reach a screenshot.
    degraded: !aiRanked,
    ...(aiFailure ? { aiFailure } : {}),
  })
})

