import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import { listRecentGmailThreads } from '@/lib/google'
import { clampInt } from '@/lib/num'
import {
  buildFocusPrompt,
  parseFocusResult,
  threadsSignature,
  getCachedFocus,
  setCachedFocus,
  heuristicFocusItems,
  type FocusItem,
} from '@/lib/gmail-focus'
import { withTimeout } from '@/lib/timeout'
import { recordAiAction } from '@/lib/ai-audit'
import { newRequestId } from '@/lib/observability'
import { geminiGenerateText } from '@/lib/gemini'
import { focusPreferencesSignature } from '@/lib/focus-preferences'
import { getFocusPreferences } from '@/lib/focus-preferences-db'

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


export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  const userEmail = session.user.email ?? 'user'
  const maxResults = clampInt(req.nextUrl.searchParams.get('maxResults'), FOCUS_THREAD_POOL, 5, 50)

  let threads
  try {
    threads = await listRecentGmailThreads(auth.accessToken, { maxResults })
  } catch (err) {
    return googleApiErrorResponse(err)
  }

  if (threads.length === 0) {
    return NextResponse.json({ items: [], generatedAt: new Date().toISOString(), cached: false })
  }

  // Per-user personalization (VIP list + goals). FAIL-OPEN: an outage or an
  // empty row returns EMPTY prefs, so ranking degrades to the pre-feature
  // behavior instead of failing the request.
  const prefs = await getFocusPreferences(userEmail)

  // Serve from cache while the inbox composition AND the preferences are
  // unchanged and fresh — editing VIPs/goals must invalidate a cached ranking.
  const signature = `${threadsSignature(threads)}#${focusPreferencesSignature(prefs)}`
  const cached = getCachedFocus(userEmail, signature)
  if (cached) {
    return NextResponse.json({
      items: cached.items,
      generatedAt: cached.generatedAt,
      cached: true,
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

  // ── AI ranking with a hard time budget, heuristic fallback below ──
  // Ranking goes through the SAME Gemini configuration the chat path uses in
  // production (lib/gemini geminiGenerateText). Whatever happens — model
  // failure, timeout, empty/garbled output — the strip still renders: the
  // deterministic heuristic ranks from live inbox signals instead.
  let items: FocusItem[] = []
  let model = 'heuristic'
  let aiFailure: string | null = null
  // True once the model returns a VALID ranking — even an empty one. A genuine
  // empty verdict ("inbox of pure noise", which buildFocusPrompt explicitly
  // permits) must be honored, NOT overridden by the heuristic. The heuristic is
  // reserved for real failures: timeout, exception, or unparseable output.
  let aiRanked = false
  try {
    const prompt = buildFocusPrompt(userEmail, threads, prefs)
    const ranked = await withTimeout(
      geminiGenerateText(
        'You are an inbox triage assistant. Follow the instructions in the user message exactly and respond with ONLY the requested JSON array — no markdown, no prose.',
        prompt,
      ),
      20_000,
      null,
      'gmail-focus-rank',
    )
    if (ranked) {
      const result = parseFocusResult(ranked.text, new Set(threads.map(t => t.id)))
      if (result.parsed) {
        aiRanked = true
        items = result.items
        model = ranked.model // credit the model even for a valid empty ranking
      } else {
        aiFailure = 'unparseable model output'
      }
    } else {
      aiFailure = 'rank timeout (20s)'
    }
  } catch (err) {
    aiFailure = err instanceof Error ? err.message.slice(0, 200) : 'unknown error'
  }

  // Heuristic fallback ONLY on a real AI failure — never to override a valid
  // (possibly empty) model ranking. The heuristic still honors VIPs so flagged
  // senders surface even during a total model outage.
  if (!aiRanked) {
    items = heuristicFocusItems(threads, { vips: prefs.vips })
  }

  const generatedAt = new Date().toISOString()
  setCachedFocus(userEmail, {
    signature,
    // Heuristic results are a stopgap — keep them briefly so the AI ranker is
    // retried soon; genuine AI rankings hold for the full TTL.
    expiresAt: Date.now() + (model !== 'heuristic' ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS),
    generatedAt,
    model,
    items,
  })

  await recordAiAction({
    ...auditBase,
    // A failure means the AI never produced a valid ranking (aiRanked stayed
    // false and we fell back to the heuristic). A valid empty verdict is success.
    status: aiFailure ? 'failed' : 'success',
    target: { ...auditBase.target, model, itemCount: items.length },
    ...(aiFailure ? { error: aiFailure } : {}),
  })
  return NextResponse.json({ items, generatedAt, cached: false })
}

