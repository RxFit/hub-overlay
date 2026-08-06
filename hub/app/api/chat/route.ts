import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAccessTokenLenient } from '@/lib/google-session'
import { resolveDriveLinkContext } from '@/lib/drive-links'
import { createLogger } from '@/lib/logger'
import { streamChat, buildSystemPromptParts, friendlyModelError } from '@/lib/gemini'
import { resolveReadTools } from '@/lib/ai-tools/resolve'
import type { SystemPromptParts } from '@/lib/claude'
import { getCompanies, getIssues, getAgents, getRuns } from '@/lib/paperclip'
import { searchSemanticBrain } from '@/lib/vertex'
import { searchWeb, parseSubQueries, mergeExaResults, type ExaSearchResult } from '@/lib/exa'
import { resolveAttachmentContext } from '@/lib/attachment-resolver'
import { loadSkillContent } from '@/lib/skills-loader'
import { SKILL_MAP } from '@/lib/skills'
import { needsInternalSearch, needsExternalSearch, isTrivialMessage } from '@/lib/search-routing'
import { ChatRequestSchema } from '@/lib/zod-schemas'
import { boundHistory, MAX_HISTORY_MESSAGES } from '@/lib/history-window'
import { extractSuggestedToolsJson, sanitizeAssistantHistoryContent } from '@/lib/model-output'
import { buildGoogleWorkspaceContext } from '@/lib/google-context'
import { getChatSpacePreferences } from '@/lib/chat-space-preferences-db'
import { withTimeout } from '@/lib/timeout'
import { chatErrorBody } from '@/lib/chat-error'
import { breaker, CircuitOpenError } from '@/lib/circuit-breaker'
import { checkRateLimit } from '@/lib/rate-limit'
import { emit, newRequestId } from '@/lib/observability'
import type { ChatMessage, ChatAttachment } from '@/types'
import '@/lib/validate-keys'  // Side-effect import: validates API keys on cold start

const log = createLogger('chat')

export const runtime = 'nodejs'
// Platform request ceiling — the outermost rung of the timeout ladder. Must be a
// literal for Next's static analysis; mirrored as ROUTE_MAX_DURATION_MS (120_000)
// in lib/timeout-config.ts, where the full ladder and its ordering invariant live.
export const maxDuration = 120

// Body-size ceiling (Backend_Hardening_H1_M5_C6): reject oversized payloads
// before JSON parsing so a single request can't buffer unbounded input.
const MAX_BODY_BYTES = 524_288 // 512KB

// Search-routing heuristics live in lib/search-routing.ts (word-boundary
// matched + unit-tested) — imported above as needsInternalSearch / needsExternalSearch.

/**
 * Search pipeline (Vertex AI + pgvector + Exa). Depends only on the query and
 * useCase, so it can run concurrently with context assembly. 10s aggregate timeout.
 */
async function runSearchPipeline(query: string, effectiveUseCase: string): Promise<string[]> {
  return withTimeout(
    (async () => {
        const searchPromises: Promise<string | null>[] = []

        const explicitInternalReq = needsInternalSearch(query)
        // Trivial greetings/acks ("thanks", "ok", "got it", 👍) need no internal
        // context, so skip the Vertex + pgvector fan-out entirely (cost/latency).
        // Conservative: any question, >3 words, or search signal → not trivial.
        const trivial = isTrivialMessage(query)
        const shouldRunVertex = !trivial && (effectiveUseCase === 'deep_dive' || effectiveUseCase === 'interview' || (effectiveUseCase === 'execute' && explicitInternalReq))
        const shouldRunPgVector = !trivial && (effectiveUseCase === 'recall' || effectiveUseCase === 'deep_dive' || effectiveUseCase === 'interview' || (effectiveUseCase === 'execute' && explicitInternalReq))

        if (trivial) {
          log.info({ trivial }, 'Internal search (Vertex + pgvector) skipped for trivial message')
        }
        log.info({ effectiveUseCase, shouldRunVertex, shouldRunPgVector, explicitInternalReq, trivial }, 'Search routing decision')

        // Try Vertex AI for internal context
        if (shouldRunVertex) {
          searchPromises.push(
            (async () => {
              try {
                // Circuit breaker: trips after 3 consecutive Vertex AI failures,
                // opens for 60s. Prevents repeated 10s timeout hangs during outages.
                const vertexResults = await breaker.execute('vertex-ai', () => searchSemanticBrain(query))
                if (vertexResults && vertexResults.length > 0) {
                  const vertexContext = vertexResults
                    .map(r => `**${r.title}** ${r.uri ? `(${r.uri})` : ''}\n${r.snippet}`)
                    .join('\n\n---\n\n')
                  return `## Internal Knowledge (Vertex AI — Google Drive/Workspace)\n\n${vertexContext}\n\n`
                }
                // Vertex returned no results — tell the LLM explicitly so it doesn't fabricate diagnostics
                return `## Internal Knowledge (Vertex AI)\n\n[No matching documents found in the internal knowledge base for this query. The user can search Google Drive directly from the Documents panel on the left sidebar, or try refining their search terms. Do NOT blame Paperclip or claim Google services are down — they are independent.]\n\n`
              } catch (err) {
                if (err instanceof CircuitOpenError) {
                  log.warn({ key: 'vertex-ai' }, 'Vertex AI circuit is OPEN — skipping search')
                  return `## Internal Knowledge (Vertex AI)\n\n[Vertex AI search is temporarily unavailable due to repeated failures. Google Drive, Calendar, Tasks, and Chat are unaffected. Suggest the user check the Documents panel on the left.]\n\n`
                }
                log.warn({ err }, 'Vertex AI search failed')
                return `## Internal Knowledge (Vertex AI)\n\n[Vertex AI search encountered an error. Google Drive, Calendar, Tasks, and Chat are unaffected — they use the user's OAuth session, not Vertex AI. Suggest the user check the Documents panel on the left.]\n\n`
              }
            })()
          )
        } else {
          log.info({ effectiveUseCase }, 'Vertex AI search skipped by routing policy')
        }

        // Query pgvector Obsidian semantic database for project insights
        if (shouldRunPgVector) {
          searchPromises.push(
            (async () => {
              try {
                const { getTenantId } = await import('@/lib/tenant-context')
                const tenantId = getTenantId()
                const { searchSimilarDocuments, SIMILARITY_THRESHOLD } = await import('@/lib/vector-store')
                const requestedLimit = 3
                const pgvectorResults = await searchSimilarDocuments(tenantId, query, requestedLimit)
                
                // Log per-chunk scores for observability
                if (pgvectorResults && pgvectorResults.length > 0) {
                  const scores = pgvectorResults.map(r => ({
                    id: r.id,
                    sourceUrl: r.sourceUrl,
                    similarity: Number(r.similarity).toFixed(4),
                  }))
                  log.info({ scores, threshold: SIMILARITY_THRESHOLD }, 'pgvector semantic results returned')
                }

                if (pgvectorResults && pgvectorResults.length < requestedLimit) {
                  const discarded = requestedLimit - pgvectorResults.length
                  log.info({ returned: pgvectorResults.length, discarded, threshold: SIMILARITY_THRESHOLD },
                    'Few chunks met relevance threshold')
                }
                
                if (pgvectorResults && pgvectorResults.length > 0) {
                  const pgvectorContext = pgvectorResults
                    .map(r => `**Source: ${r.sourceUrl}** (Similarity: ${(Number(r.similarity) * 100).toFixed(1)}%)\n${r.content}`)
                    .join('\n\n---\n\n')
                  return `## Internal Knowledge (Obsidian Semantic Database)\n\n${pgvectorContext}\n\n`
                }
              } catch (err) {
                log.warn({ err }, 'pgvector semantic search failed')
              }
              return null
            })()
          )
        } else {
          log.info({ effectiveUseCase }, 'pgvector search skipped by routing policy')
        }

        // Use Exa.AI for external queries
        if (needsExternalSearch(query)) {
          searchPromises.push(
            (async () => {
              try {
                // Circuit breaker: trips after 3 consecutive Exa failures
                const exaResults = await breaker.execute('exa-search', () => searchWeb(query, {
                  numResults: 5,
                  useAutoprompt: true,
                }))
                if (exaResults.length > 0) {
                  const exaContext = exaResults
                    .map(r => {
                      let entry = `**${r.title ?? 'Untitled'}** — [${r.url}]`
                      if (r.publishedDate) entry += ` (${r.publishedDate.split('T')[0]})`
                      if (r.snippet) entry += `\n${r.snippet}`
                      return entry
                    })
                    .join('\n\n---\n\n')
                  return `## External Web Research (Exa.AI)\n\n${exaContext}\n\n`
                }
              } catch (err) {
                if (err instanceof CircuitOpenError) {
                  log.warn({ key: 'exa-search' }, 'Exa circuit is OPEN — skipping web search')
                  return null
                }
                log.warn({ err }, 'Exa.AI search failed')
              }
              return null
            })()
          )
        }

        const results = await Promise.all(searchPromises)
        return results.filter((r): r is string => r !== null)
      })(),
    10_000,
    [] as string[],
    'search-pipeline',
  )
}

/**
 * EXA Search mode — forced Exa.AI web search, independent of the query-routing
 * heuristics used by the normal pipeline. Runs ONLY Exa (no Vertex, no pgvector,
 * no internal context) so the header toggle can never trigger another tool.
 * Returns a formatted results block for injection, or '' on empty/failure.
 */
async function runExaOnlySearch(query: string): Promise<{ context: string; failed: boolean }> {
  return withTimeout(
    (async () => {
      try {
        // ── 1. Query decomposition (deep-research pattern) ──
        // A fast planner turns the question into complementary search angles;
        // planner failure fails OPEN to the original query alone.
        let queries: string[] = [query]
        try {
          const { geminiGenerateText } = await import('@/lib/gemini')
          const plan = await withTimeout(
            geminiGenerateText(
              'You decompose research questions into web-search queries. Respond with ONLY a JSON array of 3 short, distinct search queries covering complementary angles of the user\'s question (different subtopics, comparisons, or evidence types — not rephrasings). No markdown, no prose.',
              query,
            ),
            6_000,
            null,
            'exa-query-planner',
          )
          if (plan?.text) queries = parseSubQueries(plan.text, query, 4)
        } catch (err) {
          log.warn({ err }, 'EXA query planner failed — single-query search')
        }

        // ── 2a. Server-side deep fan-out (preferred) ──
        // Exa's `deep` search tier runs ITS OWN parallel search agents over
        // the main query + our planner's variations (4-15s) — the same
        // orchestrator/worker pattern Exa Deep uses internally. If the tier
        // is unavailable on this plan/SDK, fall back to client-side parallel
        // `auto` searches (2b).
        let merged: ExaSearchResult[] | null = null
        try {
          const deep = await breaker.execute('exa-search', () => searchWeb(query, {
            type: 'deep',
            additionalQueries: queries.slice(1),
            numResults: 12,
            useAutoprompt: true,
            maxCharacters: 3000,
          }))
          if (deep.length > 0) {
            merged = deep
            log.info({ queryCount: queries.length, resultCount: deep.length }, 'EXA search mode: Exa deep-tier fan-out complete')
          }
        } catch (err) {
          log.warn({ err }, 'EXA deep-tier search failed — falling back to parallel auto searches')
        }

        // ── 2b. Client-side parallel semantic searches (fallback) ──
        const perQuery = queries.length > 1 ? 5 : 8
        const settled = merged ? [] : await Promise.allSettled(
          queries.map(q =>
            breaker.execute('exa-search', () => searchWeb(q, {
              numResults: perQuery,
              useAutoprompt: true,
              maxCharacters: 3000,
            }))
          )
        )
        const resultLists = settled
          .filter((r): r is PromiseFulfilledResult<ExaSearchResult[]> => r.status === 'fulfilled')
          .map(r => r.value)

        if (!merged && resultLists.length === 0) {
          // Every parallel search FAILED — disclose, don't disguise as empty.
          const firstErr = settled.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined
          if (firstErr?.reason instanceof CircuitOpenError) {
            log.warn({ key: 'exa-search' }, 'Exa circuit is OPEN — EXA search unavailable')
          } else {
            log.warn({ err: firstErr?.reason }, 'EXA search mode: all parallel Exa queries failed')
          }
          return { context: '', failed: true }
        }

        // ── 3. Merge: round-robin interleave, dedupe by URL, cap sources ──
        if (!merged) {
          merged = mergeExaResults(resultLists, 12)
          log.info(
            { queryCount: queries.length, resultCount: merged.length },
            'EXA search mode: parallel Exa.AI fan-out complete'
          )
        }
        if (merged.length === 0) return { context: '', failed: false }

        const context = merged
          .map(r => {
            let entry = `**${r.title ?? 'Untitled'}** — [${r.url}]`
            if (r.publishedDate) entry += ` (${r.publishedDate.split('T')[0]})`
            if (r.snippet) entry += `\n${r.snippet}`
            return entry
          })
          .join('\n\n---\n\n')
        return { context, failed: false }
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          log.warn({ key: 'exa-search' }, 'Exa circuit is OPEN — EXA search unavailable')
        } else {
          log.warn({ err }, 'EXA search mode Exa.AI query failed')
        }
        return { context: '', failed: true }
      }
    })(),
    30_000,
    { context: '', failed: true },
    'exa-only-search',
  )
}

/**
 * Streams a model response as an SSE Response. Extracted so both the normal chat
 * path and the EXA Search path share the exact same streaming/abort/error and
 * suggestedTools handling. In EXA mode the system prompt does not request
 * suggestedTools, so the extract below simply yields nothing.
 */
function streamModelResponse(
  boundedMessages: ChatMessage[],
  systemPrompt: SystemPromptParts,
  effectiveUseCase: string,
  hasActiveSkill: boolean,
  req: NextRequest,
): Response {
  // Correlation id for the whole AI request lifecycle. `ai_request_start` here
  // pairs with the terminal `ai_complete`/`ai_error` emitted inside streamChat.
  const requestId = newRequestId()
  emit({ type: 'ai_request_start', requestId, route: '/api/chat' })

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      // Client abort (CLIENT_ABORT_MS): the browser gives up at 45s but the
      // rotation would otherwise churn model + Paperclip compute up to
      // maxDuration (120s). Thread req.signal into the rotation (which checks it
      // between attempts) AND check it in this pump so we stop enqueuing the
      // moment the client is gone. Bailing on abort is a clean stop — it must
      // never surface a user-visible error into an already-abandoned response.
      const signal = req.signal
      try {
        let fullText = ''
        for await (const chunk of streamChat(boundedMessages, systemPrompt, effectiveUseCase, hasActiveSkill, requestId, signal)) {
          if (signal.aborted) break
          if (typeof chunk === 'object' && 'modelUsed' in chunk) {
            // Emit model identification event to the UI
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ modelUsed: chunk.modelUsed })}\n\n`))
            continue
          }
          // Defensive: never put empty text frames on the wire (reasoning-phase
          // keep-alives are consumed inside the rotation layer, but any that
          // slip through carry no information for the client).
          if (chunk.length === 0) continue
          fullText += chunk
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`))
        }

        // If the client went away, stop here — no suggestedTools, no [DONE].
        if (signal.aborted) return

        // Parse suggestedTools metadata from AI response.
        // P1-1: validate every id against the real skill catalog before emitting,
        // so injected/hallucinated content can't surface bogus or unsafe tool ids.
        const toolsJson = extractSuggestedToolsJson(fullText)
        if (toolsJson) {
          try {
            const parsed = JSON.parse(toolsJson)
            const tools = Array.isArray(parsed)
              ? parsed.filter((id: unknown): id is string => typeof id === 'string' && id in SKILL_MAP).slice(0, 5)
              : []
            if (tools.length > 0) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ suggestedTools: tools })}\n\n`))
            }
          } catch {
            // Skip malformed suggestedTools
          }
        }

        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (err) {
        // A client abort can surface as a thrown error from the rotation or from
        // enqueue on a torn-down stream — that's not a real failure, so stop
        // quietly without emitting an error frame to a client that is gone.
        if (signal.aborted) {
          log.info('Chat stream aborted by client — stopping early')
        } else {
          // Keep the REAL provider error in Cloud Run logs for operators...
          log.error({ err }, 'Chat stream failed')
          // ...but only ever send a clean, non-leaky message to the user.
          const message = friendlyModelError(err)
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`))
          } catch {
            // Stream already torn down (e.g. late abort) — nothing to send.
          }
        }
      } finally {
        try {
          controller.close()
        } catch {
          // Controller already closed/errored by the platform after a client abort.
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}

async function handleChat(req: NextRequest): Promise<Response> {
  // Auth check
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Rate limit AFTER auth — unauthenticated requests still get 401 above, and
  // the limiter key is the authenticated email (not a spoofable header).
  const rate = checkRateLimit(session.user.email ?? 'anonymous')
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many requests — please slow down.' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec ?? 60) } },
    )
  }

  // Body-size guard: check content-length first; Next/undici may omit it for
  // streamed bodies, so fall back to measuring the raw text (body read once).
  const contentLength = req.headers.get('content-length')
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Request too large' }, { status: 413 })
  }

  let body: { messages: ChatMessage[]; useCase?: string; attachments?: ChatAttachment[]; activeSkill?: string; exaMode?: boolean }
  try {
    const rawBody = await req.text()
    if (rawBody.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Request too large' }, { status: 413 })
    }
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { messages, useCase = 'deep_dive', attachments, activeSkill, exaMode = false } = body

  // Validate core message structure — always validate the FULL incoming array.
  const msgValidation = ChatRequestSchema.pick({ messages: true }).safeParse({ messages })
  if (!msgValidation.success) {
    return NextResponse.json({ error: 'Messages array required', details: msgValidation.error.issues }, { status: 400 })
  }

  // Bound the history sent to the model + search pipeline (W1-#7): keep only the
  // most recent MAX_HISTORY_MESSAGES so token cost/latency don't grow unbounded
  // with session length. Server-side cap = defense-in-depth regardless of client.
  // The full `messages` array above is still what gets Zod-validated; only what's
  // forwarded downstream is bounded. Since we keep the tail, the latest user
  // message is always retained (lastUserMsg is derived from boundedMessages below).
  // Sanitize assistant history before it goes back to a model: strip the
  // degraded-mode banner and the suggestedTools metadata comment. Both are
  // harness artifacts stored inside the visible bubble content — echoing them
  // back as history teaches the model to reproduce them (the doubled
  // "⚠️ Primary model unavailable" banner seen during provider outages).
  // A bubble that was ONLY a banner sanitizes to empty — drop it entirely so
  // no provider sees an empty assistant turn.
  const recentMessages = boundHistory(messages)
  if (recentMessages.length < messages.length) {
    log.info(
      { total: messages.length, forwarded: recentMessages.length, dropped: messages.length - recentMessages.length, max: MAX_HISTORY_MESSAGES },
      'Chat history truncated to recency window',
    )
  }
  const boundedMessages = recentMessages
    .map(m => (m.role === 'assistant' ? { ...m, content: sanitizeAssistantHistoryContent(m.content) } : m))
    .filter(m => m.role !== 'assistant' || m.content.length > 0)

  // ── EXA Search mode — short-circuit before ANY other tool/context runs ──
  // The header EXA toggle turns this chat into a pure Exa.AI web-search
  // summarizer. Per the feature's contract, no other tool may fire while it's
  // on: skip Vertex, pgvector, Paperclip, Google Workspace context, attachments,
  // and skills entirely. Run only a forced Exa search, then let the model
  // synthesize + cite from those results.
  if (exaMode) {
    const exaLastUserMsg = boundedMessages.filter(m => m.role === 'user').pop()
    const exaQuery = exaLastUserMsg?.content ?? ''
    log.info({ hasQuery: Boolean(exaQuery) }, 'EXA Search mode active — hybrid semantic pipeline (Exa web + Vertex internal)')

    // Hybrid SEMANTIC-ONLY research: Exa (web) + Vertex AI Internal Brain run
    // CONCURRENTLY, each failing open independently — a Vertex outage must not
    // kill web results and vice versa. Everything else (pgvector, Paperclip,
    // Workspace context, attachments, skills) stays disabled in this mode —
    // EXCEPT documents the user explicitly linked by URL in their message:
    // those are user-supplied context, not a tool, and refusing to read a link
    // the user just pasted is indistinguishable from a bug to them.
    const [exaSearch, internalSearch, exaDriveLinks] = await Promise.all([
      exaQuery ? runExaOnlySearch(exaQuery) : Promise.resolve({ context: '', failed: false }),
      exaQuery
        ? withTimeout(
            (async () => {
              try {
                const vertexResults = await breaker.execute('vertex-ai', () => searchSemanticBrain(exaQuery))
                if (vertexResults === null) {
                  // searchSemanticBrain's null contract: the backend is
                  // unavailable/misconfigured (no service account, HTTP error).
                  // Reporting that as "zero matches" made the model tell the
                  // user their documents don't exist during outages.
                  log.warn('EXA hybrid: Vertex returned null (unavailable) — disclosing as failed, not empty')
                  return { context: '', failed: true }
                }
                if (vertexResults.length > 0) {
                  const ctx = vertexResults
                    .map(r => `**${r.title}** ${r.uri ? `(${r.uri})` : ''}\n${r.snippet}`)
                    .join('\n\n---\n\n')
                  return { context: ctx, failed: false }
                }
                return { context: '', failed: false } // genuinely zero matches
              } catch (err) {
                if (err instanceof CircuitOpenError) {
                  log.warn({ key: 'vertex-ai' }, 'Vertex circuit OPEN — EXA hybrid runs web-only')
                } else {
                  log.warn({ err }, 'EXA hybrid: Vertex internal search failed — web-only')
                }
                return { context: '', failed: true }
              }
            })(),
            8_000,
            { context: '', failed: true },
            'exa-internal-search',
          )
        : Promise.resolve({ context: '', failed: false }),
      withTimeout(
        (async () => {
          const tokenState = await resolveGoogleAccessTokenLenient(req)
          return resolveDriveLinkContext(exaQuery, tokenState.ok ? tokenState.accessToken : undefined)
        })(),
        12_000,
        '',
        'exa-drive-links',
      ),
    ])

    // Parts form → Claude puts a cache breakpoint on the static prefix
    // (persona + policy) so repeat EXA turns read it at 0.1x input price.
    const exaSystemPrompt = buildSystemPromptParts({
      injectedContext: exaSearch.context || undefined,
      exaMode: true,
      exaSearchFailed: exaSearch.failed,
      exaInternalContext: internalSearch.context || undefined,
      exaInternalFailed: internalSearch.failed,
      driveLinkContext: exaDriveLinks || undefined,
    })
    // 'exa_search' routes to the Claude chain (Fable 5 → Sonnet 4.6 → Gemini
    // fallbacks) — research synthesis with citations needs the strongest model,
    // not the Gemini Flash default that plain no-skill deep_dive falls to.
    return streamModelResponse(boundedMessages, exaSystemPrompt, 'exa_search', false, req)
  }

  // ── Parallel pre-stream context assembly ──
  // Paperclip context (8s timeout) and Google Workspace context (6s timeout)
  // were previously sequential (worst case 14s before streaming starts).
  // Now they run concurrently via Promise.all (worst case 8s).
  //
  // The Google OAuth token is resolved first since it's a local JWT decode
  // (sub-ms) that both the Google WS fetch and attachment handling need.
  const chatUser = session.user as Record<string, unknown>
  const chatRole = chatUser.role as string
  const chatAssignedProjects = (chatUser.assignedProjects as string[]) ?? []
  let projectContext = ''
  let agentActivity = ''

  // Same three token checks every /api/google/* route applies (fatal refresh
  // error, missing token, expired-in-cookie access token) — but soft: chat
  // still answers without Workspace data. Previously a bare getToken() here
  // handed dead tokens to every Google consumer, whose failures are silently
  // swallowed — ALL Drive/Gmail/Calendar data vanished from the model's
  // context with no signal to the user. Now the model is told why, so it says
  // "reconnect Google" instead of "you have no documents".
  const googleTokenState = await resolveGoogleAccessTokenLenient(req)
  const googleAccessToken = googleTokenState.ok ? googleTokenState.accessToken : undefined
  let googleAuthNotice: string | undefined
  if (!googleTokenState.ok) {
    log.warn({ reason: googleTokenState.reason }, 'Chat running without Google Workspace access')
    googleAuthNotice =
      googleTokenState.reason === 'reauth'
        ? '[Google Workspace access is UNAVAILABLE this turn: the user\'s Google session has expired or been revoked. No Drive, Gmail, Calendar, Tasks, or Chat data could be read. If the user asks about their files, email, or schedule, tell them to sign out of the Hub and sign back in to reconnect Google — do NOT tell them the data does not exist, and do NOT invent it.]'
        : '[Google Workspace access is TEMPORARILY unavailable this turn (the Google session token is refreshing). No Drive, Gmail, Calendar, Tasks, or Chat data could be read. If the user asks about their files or email, tell them to retry in a moment — do NOT tell them the data does not exist, and do NOT invent it.]'
  }

  // Search depends only on the query + useCase (not on Paperclip/Google context),
  // so kick it off NOW to run CONCURRENTLY with the context fetches below.
  const effectiveUseCase = activeSkill ? 'deep_dive' : useCase
  const lastUserMsg = boundedMessages.filter(m => m.role === 'user').pop()
  const query = lastUserMsg?.content ?? ''
  // Read-tool resolution (analytics + Drive/Chat lookups) is independent of the
  // Paperclip/Google context fetches, so start it here to run concurrently
  // rather than adding its latency on top. Resolves to an empty result for
  // questions that need no lookup.
  const readToolsPromise = resolveReadTools(query, chatRole, googleAccessToken)

  const searchPromise: Promise<string[]> = query
    ? runSearchPipeline(query, effectiveUseCase)
    : Promise.resolve([])

  const [paperclipContextResult, googleWsResult] = await Promise.all([
    // Branch 1: Paperclip orchestration context (8s timeout)
    withTimeout(
      (async () => {
        try {
          let companies = await getCompanies()

          // Scope to user's assigned workspaces (admin/superadmin with ['*'] see all)
          if (chatRole !== 'superadmin' && !chatAssignedProjects.includes('*')) {
            companies = companies.filter(c => chatAssignedProjects.includes(c.id))
          }

          const pc = companies
            .map(c => `- ${c.name} (${c.identifier}): ${c.issueCount ?? '?'} issues, ${c.memberCount ?? '?'} members`)
            .join('\n')

          // Get recent issues across scoped companies (first 3 for context)
          const issuePromises = companies.slice(0, 3).map(c =>
            getIssues(c.id, { limit: 5 }).catch(() => [])
          )
          const issueResults = await Promise.all(issuePromises)
          const allIssues = issueResults.flat()
          let aa = allIssues
            .slice(0, 10)
            .map(i => `- [${i.identifier}] ${i.title} (${i.state?.name ?? 'unknown'})`)
            .join('\n')

          // Also get agent status for system prompt context — INDIVIDUAL details, not just counts
          try {
            const agentPromises = companies.slice(0, 3).map(c =>
              getAgents(c.id).catch(() => [])
            )
            const agentResults = await Promise.all(agentPromises)
            const allAgents = agentResults.flat()
            const healthy = allAgents.filter(a => a.status === 'active').length
            const errored = allAgents.filter(a => a.status === 'error').length
            const inactive = allAgents.filter(a => a.status === 'inactive').length
            aa += '\nAgent Fleet Status: ' + allAgents.length + ' total — ' + healthy + ' active, ' + errored + ' errored, ' + inactive + ' inactive'

            // List individual agents so the LLM has real data for audits
            if (allAgents.length > 0) {
              aa += '\n\nAgent Details:'
              for (const agent of allAgents) {
                const heartbeat = agent.lastHeartbeat
                  ? ` (last heartbeat: ${new Date(agent.lastHeartbeat).toLocaleString('en-US', { timeZone: 'America/Chicago' })})`
                  : ' (no heartbeat recorded)'
                aa += `\n  - ${agent.name}: ${agent.status.toUpperCase()}${heartbeat}`
              }
            }

            // Surface errored agents prominently
            const erroredAgents = allAgents.filter(a => a.status === 'error')
            if (erroredAgents.length > 0) {
              aa += '\n\n⚠️ ERRORED AGENTS:'
              for (const agent of erroredAgents) {
                aa += `\n  - ${agent.name} (${agent.id}) — status: error, adapter: ${agent.adapter}`
              }
            }
          } catch (agentErr) {
            log.warn({ err: agentErr }, 'Agent status fetch failed — skipping agent context')
          }

          // Fetch recent runs to provide actual execution history for audit queries
          try {
            const runPromises = companies.slice(0, 3).map(c =>
              getRuns(c.id, { limit: 5 }).catch(() => [])
            )
            const runResults = await Promise.all(runPromises)
            const allRuns = runResults.flat()
            if (allRuns.length > 0) {
              aa += '\n\nRecent Agent Runs:'
              for (const run of allRuns.slice(0, 10)) {
                const duration = run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : 'n/a'
                const started = run.startedAt ? new Date(run.startedAt).toLocaleString('en-US', { timeZone: 'America/Chicago' }) : 'unknown'
                aa += `\n  - [${run.issueIdentifier}] ${run.agentName}: ${run.status.toUpperCase()} (${duration}, started: ${started})`
              }
              const failedRuns = allRuns.filter(r => r.status === 'failed')
              if (failedRuns.length > 0) {
                aa += `\n\n⚠️ ${failedRuns.length} FAILED RUNS in recent history`
              }
            }
          } catch (runErr) {
            log.warn({ err: runErr }, 'Run history fetch failed — skipping run context')
          }

          return { projectContext: pc, agentActivity: aa }
        } catch (ctxErr) {
          log.warn({ err: ctxErr }, 'Paperclip context fetch failed — proceeding without project context')
          return { projectContext: '[Paperclip orchestration data unavailable — this does NOT affect Google Drive, Calendar, Tasks, Gmail, or Chat. Those services are powered by the user\'s OAuth session and work independently via the left panel.]', agentActivity: '' }
        }
      })(),
      8_000,
      { projectContext: '[Paperclip project context timed out — Google Workspace features (Drive, Calendar, Tasks, Chat, Gmail) are unaffected and remain available via the left panel.]', agentActivity: '' },
      'paperclip-context'
    ),

    // Branch 2: Google Workspace context (6s timeout) — runs in parallel
    googleAccessToken
      ? withTimeout(
          // The Chat section of this context honors the user's space visibility
          // preferences, so the model sees their real spaces instead of a wall
          // of auto-created Meet conversations. Fail-open to defaults.
          getChatSpacePreferences(session.user.email ?? '')
            .then(prefs => buildGoogleWorkspaceContext(googleAccessToken, prefs))
            .catch((err) => {
            log.warn({ err }, 'Google Workspace context fetch failed — proceeding without it')
            return null
          }),
          6_000,
          null,
          'google-workspace-context',
        )
      : Promise.resolve(null),
  ])

  projectContext = paperclipContextResult.projectContext
  agentActivity = paperclipContextResult.agentActivity

  let googleWorkspaceDetail: string | undefined
  let googleWorkspaceCounts: { taskCount?: number; upcomingEvents?: number; recentFiles?: number; unreadEmails?: number } = {}
  if (googleWsResult) {
    googleWorkspaceDetail = googleWsResult.detail
    googleWorkspaceCounts = googleWsResult.counts
  }

  const searchResults = await searchPromise
  const searchContext = searchResults.join('')

  // Resolve attachments into text context. Extracted to resolveAttachmentContext
  // (lib/attachment-resolver.ts), which resolves the (independent) attachments
  // CONCURRENTLY — preserving the .slice(0,5) cap, input order of the injected
  // blocks, per-attachment error isolation, and every existing timeout. This cuts
  // worst-case time-to-first-token from serial (~30-40s for 3-5 items) to parallel.
  const [attachmentContext, driveLinkContext] = await Promise.all([
    resolveAttachmentContext(attachments, lastUserMsg, googleAccessToken),
    // Drive links pasted directly into the message text — read with the
    // user's token, deterministically (no planner in the loop).
    resolveDriveLinkContext(query, googleAccessToken),
  ])

  // Combine all injected context
  const allInjectedContext = [searchContext, attachmentContext].filter(Boolean).join('\n\n')

  // Load active skill content if specified
  let activeSkillContent: string | undefined
  if (activeSkill) {
    const content = await loadSkillContent(activeSkill)
    if (content) activeSkillContent = content
  }

  // Parts form for prompt caching — static persona/policy prefix cached,
  // dynamic context (date, workspace, search results) after the breakpoint.
  const liveAnalytics = await readToolsPromise

  const systemPrompt = buildSystemPromptParts({
    projects: projectContext,
    agentActivity,
    googleWorkspace: Object.keys(googleWorkspaceCounts).length > 0 ? googleWorkspaceCounts : undefined,
    googleWorkspaceDetail,
    googleAuthNotice,
    liveAnalytics: liveAnalytics.context,
    injectedContext: allInjectedContext || undefined,
    driveLinkContext: driveLinkContext || undefined,
    activeSkill: activeSkill || undefined,
    activeSkillContent,
  })

  // effectiveUseCase already computed above (before search routing) for consistency

  // Stream response (shared with the EXA Search path — see streamModelResponse).
  return streamModelResponse(boundedMessages, systemPrompt, effectiveUseCase, Boolean(activeSkill), req)
}

export async function POST(req: NextRequest) {
  try {
    return await handleChat(req)
  } catch (err) {
    log.error({ err }, 'Chat request failed before streaming started')
    // Raw error text is dev-only diagnostics — production bodies must stay generic.
    return NextResponse.json(
      chatErrorBody(err, process.env.NODE_ENV === 'production'),
      { status: 500 },
    )
  }
}
