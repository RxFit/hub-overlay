import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import { listRecentGmailThreads } from '@/lib/google'
import { clampInt } from '@/lib/num'
import {
  buildFocusPrompt,
  parseFocusResponse,
  threadsSignature,
  getCachedFocus,
  setCachedFocus,
} from '@/lib/gmail-focus'
import { recordAiAction } from '@/lib/ai-audit'
import { newRequestId } from '@/lib/observability'
import { GoogleGenerativeAI } from '@google/generative-ai'

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

/* Routine-path Gemini chain (matches lib/gemini GEMINI_MODEL_CHAIN policy):
   3.5 Flash first, self-heal down to the proven 2.5 models. */
const FOCUS_MODEL_CHAIN = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'] as const

/* Lazy-initialized so the API key is read at runtime, not module-load time
   (mirrors score-context/route.ts getGenAI()). */
let _genAI: GoogleGenerativeAI | null = null
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) {
    const key =
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      ''
    if (!key) {
      throw new Error('No Gemini API key found. Set GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY.')
    }
    _genAI = new GoogleGenerativeAI(key)
  }
  return _genAI
}

async function rankWithGemini(prompt: string): Promise<{ raw: string; model: string }> {
  let lastErr: unknown
  for (const modelName of FOCUS_MODEL_CHAIN) {
    try {
      const model = getGenAI().getGenerativeModel({
        model: modelName,
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
      })
      const result = await model.generateContent(prompt)
      const raw = result.response.text()
      // Thinking-capable models can burn the whole output budget on thoughts
      // and return empty text — treat that as a failure so the chain advances
      // instead of caching an empty strip.
      if (!raw || !raw.trim()) throw new Error(`${modelName} returned empty text`)
      return { raw, model: modelName }
    } catch (err) {
      lastErr = err
      console.warn(`[gmail-focus] ${modelName} failed, trying next in chain:`, err)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('All focus models failed')
}

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

  // Serve from cache while the inbox composition is unchanged and fresh.
  const signature = threadsSignature(threads)
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

  try {
    const prompt = buildFocusPrompt(userEmail, threads)
    const { raw, model } = await rankWithGemini(prompt)
    const items = parseFocusResponse(raw, new Set(threads.map(t => t.id)))

    const generatedAt = new Date().toISOString()
    setCachedFocus(userEmail, {
      signature,
      expiresAt: Date.now() + (items.length > 0 ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS),
      generatedAt,
      model,
      items,
    })

    await recordAiAction({
      ...auditBase,
      status: 'success',
      target: { ...auditBase.target, model, itemCount: items.length },
    })
    return NextResponse.json({ items, generatedAt, cached: false })
  } catch (err) {
    await recordAiAction({
      ...auditBase,
      status: 'failed',
      error: err instanceof Error ? err.message : 'unknown error',
    })
    // Advisory feature: degrade to an empty strip rather than an error state.
    return NextResponse.json({
      items: [],
      generatedAt: new Date().toISOString(),
      cached: false,
      degraded: true,
    })
  }
}

