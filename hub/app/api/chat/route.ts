import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAccessTokenLenient } from '@/lib/google-session'
import { resolveDriveLinkContext } from '@/lib/drive-links'
import { createLogger } from '@/lib/logger'
import { streamChat, buildSystemPromptParts, friendlyModelError } from '@/lib/gemini'
import { resolveReadTools } from '@/lib/ai-tools/resolve'
import { buildCapabilityManifest } from '@/lib/ai-tools/capabilities'
import type { SystemPromptParts } from '@/lib/claude'
import { readExecutionSnapshot, formatExecutionContext } from '@/lib/execution-context'
import { canAccessAdminRoute } from '@/lib/roles'
import { searchSemanticBrain, VertexUnavailableError } from '@/lib/vertex'
import {
  EXA_QUERY_PLANNER_MS,
  EXA_SEARCH_BRANCH_MS,
  EXA_VERTEX_BRANCH_MS,
  DRIVE_LINKS_BRANCH_MS,
} from '@/lib/timeout-config'
import { searchWeb, parseSubQueries, mergeExaResults, type ExaSearchResult } from '@/lib/exa'
import { resolveAttachmentContext } from '@/lib/attachment-resolver'
import { loadSkillContent } from '@/lib/skills-loader'
import { isDeepTool, SKILL_MAP } from '@/lib/skills'
import { needsInternalSearch, needsExternalSearch, isTrivialMessage } from '@/lib/search-routing'
import { ChatRequestSchema } from '@/lib/zod-schemas'
import { boundHistory, MAX_HISTORY_MESSAGES } from '@/lib/history-window'
import { extractSuggestedToolsJson, sanitizeAssistantHistoryContent } from '@/lib/model-output'
import { buildGoogleWorkspaceContext, type GoogleWorkspaceContext } from '@/lib/google-context'
import { getChatSpacePreferences } from '@/lib/chat-space-preferences-db'
import { withTimeout } from '@/lib/timeout'
import { breaker, CircuitOpenError } from '@/lib/circuit-breaker'
import { checkRateLimit } from '@/lib/rate-limit'
import { persistUserTurn, persistAssistantTurn } from '@/lib/chat-store'
import { emit, newRequestId } from '@/lib/observability'
import type { ChatMessage, ChatAttachment } from '@/types'
import '@/lib/validate-keys'  // Side-effect import: validates API keys on cold start
import { withFault } from '@/lib/route-fault'

const log = createLogger('chat')

/* Execution-context failure notices. Both are OUR text (not fenced) and both
   name the real cause, so the model says "the Hub's execution ledger could
   not be read" rather than inventing an outage in some other system. */
const EXECUTION_CONTEXT_FAILED =
  '[The Hub\'s own execution ledger (model runs, AI actions, deep runs, dispatch worker) could not be read this turn. If the user asks about a run, an action, or the Execution panel, say the ledger read failed and invite them to retry — do NOT claim any other system is down, and do NOT invent run details.]'
const EXECUTION_CONTEXT_TIMED_OUT =
  '[The Hub\'s own execution ledger read TIMED OUT this turn, so the "Execution Layer" section is absent. If the user asks about a run, an action, or the Execution panel, say the lookup timed out and invite them to retry — do NOT claim any other system is down, and do NOT invent run details.]'

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
                // opens for 60s. Prevents repeated full-timeout hangs during outages.
                //
                // This only works because searchSemanticBrain REJECTS on
                // unavailability. While it returned null, every failure resolved
                // successfully and reset the breaker's counter to zero, so the
                // circuit could never open and the handler below was dead code
                // (see the failure contract in lib/vertex.ts).
                const vertexResults = await breaker.execute('vertex-ai', () => searchSemanticBrain(query))
                if (vertexResults.length > 0) {
                  const vertexContext = vertexResults
                    .map(r => `**${r.title}** ${r.uri ? `(${r.uri})` : ''}\n${r.snippet}`)
                    .join('\n\n---\n\n')
                  return `## Internal Knowledge (Vertex AI — Google Drive/Workspace)\n\n${vertexContext}\n\n`
                }
                // Vertex returned no results — tell the LLM explicitly so it doesn't fabricate diagnostics
                return `## Internal Knowledge (Vertex AI)\n\n[No matching documents found in the internal knowledge base for this query. The user can search Google Drive directly from the Documents panel on the left sidebar, or try refining their search terms. Do NOT blame any other Hub system or claim Google services are down — they are independent.]\n\n`
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
            EXA_QUERY_PLANNER_MS,
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
    EXA_SEARCH_BRANCH_MS,
    { context: '', failed: true },
    'exa-only-search',
  )
}

/**
 * Either a prompt that is already assembled, or a thunk that assembles one.
 *
 * A thunk is what makes time-to-first-byte independent of context assembly. The
 * Response is constructed and returned the moment this function is called, so the
 * browser's `await fetch('/api/chat')` resolves immediately; the thunk then runs
 * INSIDE the stream, where its progress can be narrated with `status` frames.
 * SystemPromptParts is a plain `{ staticPrefix, dynamic }` object, so `typeof ===
 * 'function'` is a sound discriminant.
 */
type PromptSource = SystemPromptParts | (() => Promise<SystemPromptParts>)

/**
 * Shown in the assistant bubble while the EXA path's two backends are queried.
 * Deliberately names both — lib/gemini.ts's EXA prompt requires the answer to say
 * which backends it actually used, and the wait should not imply fewer.
 */
const EXA_ASSEMBLY_STATUS = 'Searching the web and your RxFit records…'

/**
 * Streams a model response as an SSE Response. Extracted so both the normal chat
 * path and the EXA Search path share the exact same streaming/abort/error and
 * suggestedTools handling. In EXA mode the system prompt does not request
 * suggestedTools, so the extract below simply yields nothing.
 *
 * ── Why a deferred prompt matters ──
 * Response HEADERS cannot be sent until this function returns. When the caller
 * assembled context first, every millisecond of that assembly was dead air with
 * no HTTP response in existence: the EXA path awaited a three-branch Promise.all
 * bounded at 30s (the Exa branch) before streamModelResponse was even CALLED, so
 * the client sat on a blocked `fetch` and the user watched a typing dot. Passing a
 * thunk moves that work inside `start()`, after the Response is already on the
 * wire, and lets us narrate it.
 */
function streamModelResponse(
  boundedMessages: ChatMessage[],
  promptSource: PromptSource,
  effectiveUseCase: string,
  hasActiveSkill: boolean,
  req: NextRequest,
  // Conversation persistence (Phase 2): present only when the client sent a
  // chatId. The completed answer is persisted fire-and-forget AFTER it is on
  // the wire — persistence can never delay or break the stream.
  persist?: { chatId: string; userEmail: string },
  // Shown in the assistant bubble while a deferred promptSource assembles, so a
  // returned-but-not-yet-speaking stream reads as progress rather than a hang.
  // Ignored when promptSource is already-assembled (nothing to wait for).
  assemblyStatus?: string,
): Response {
  // Correlation id for the whole AI request lifecycle. `ai_request_start` here
  // pairs with the terminal `ai_complete`/`ai_error` emitted inside streamChat.
  const requestId = newRequestId()
  emit({ type: 'ai_request_start', requestId, route: '/api/chat' })

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      // Client abort (CLIENT_ABORT_MS): the browser gives up at 45s but the
      // rotation would otherwise churn model compute up to
      // maxDuration (120s). Thread req.signal into the rotation (which checks it
      // between attempts) AND check it in this pump so we stop enqueuing the
      // moment the client is gone. Bailing on abort is a clean stop — it must
      // never surface a user-visible error into an already-abandoned response.
      const signal = req.signal
      try {
        // Assemble context (if deferred) now that the Response is already on the
        // wire. The status frame goes out FIRST so the bubble has something to
        // show for the duration; the client drops it the instant real text
        // arrives (see useChatEngine's frame dispatcher).
        let systemPrompt: SystemPromptParts
        if (typeof promptSource === 'function') {
          if (assemblyStatus) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: assemblyStatus })}\n\n`))
          }
          try {
            systemPrompt = await promptSource()
          } catch (err) {
            // Distinct from a model failure: this is pre-model context assembly.
            // It is logged separately so operators can tell the two apart, then
            // rethrown into the shared handler below, which emits the error frame.
            // NOTE: assembly used to run before the Response existed, so a throw
            // here became a withFault response carrying a HUB- id. Once headers
            // are flushed that is no longer possible — the in-stream error frame
            // is the terminal contract (see the POST docblock).
            log.error({ err, effectiveUseCase }, 'Pre-stream context assembly failed')
            throw err
          }
          // Assembly can outlast the client's patience; don't dial a provider for
          // a request nobody is waiting on.
          if (signal.aborted) return
        } else {
          systemPrompt = promptSource
        }

        let fullText = ''
        let servingModel: string | null = null
        for await (const chunk of streamChat(boundedMessages, systemPrompt, effectiveUseCase, hasActiveSkill, requestId, signal)) {
          if (signal.aborted) break
          if (typeof chunk === 'object' && 'modelUsed' in chunk) {
            // Emit model identification event to the UI
            servingModel = chunk.modelUsed
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
        // The answer is NOT persisted: only completed turns enter the record,
        // matching what the client actually displayed.
        if (signal.aborted) return

        // Persist the completed assistant turn (fire-and-forget, best-effort —
        // persistAssistantTurn never throws). The user turn was persisted at
        // request receipt in handleChat.
        if (persist && fullText.length > 0) {
          void persistAssistantTurn({
            chatId: persist.chatId,
            userEmail: persist.userEmail,
            content: fullText,
            model: servingModel,
          })
        }

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

/**
 * Outcome of the live Google Workspace context fetch. `reason` distinguishes
 * the three ways the section can be absent — an unwired session, a timeout, and
 * a fetch error — because the model has to say something different about each,
 * and saying nothing (the previous bare `null`) reads to the user as "you have
 * no data".
 */
type WorkspaceContextOutcome =
  | ({ ok: true } & GoogleWorkspaceContext)
  | { ok: false; reason: 'timeout' | 'error' | 'no-session' }

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

  let body: { messages: ChatMessage[]; useCase?: string; attachments?: ChatAttachment[]; activeSkill?: string; exaMode?: boolean; chatId?: string }
  try {
    const rawBody = await req.text()
    if (rawBody.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Request too large' }, { status: 413 })
    }
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { messages, useCase = 'deep_dive', attachments, activeSkill: rawActiveSkill, exaMode = false } = body
  // Deep tools are panel tools, never chat lenses (deep lane design §1):
  // their minutes-long run protocols execute via /api/deep-runs on the
  // desktop engine. A deep id arriving here (older client, manual call) is
  // dropped so it can neither inject its protocol nor flip the use case —
  // the server-side half of the guard in useChatEngine.
  const activeSkill = isDeepTool(rawActiveSkill) ? undefined : rawActiveSkill

  // Role is read here rather than at the context-assembly block below because
  // the EXA short-circuit needs it too — its capability manifest is role-gated
  // exactly like the normal path's.
  const chatUser = session.user as Record<string, unknown>
  const chatRole = chatUser.role as string
  const chatAssignedProjects = (chatUser.assignedProjects as string[]) ?? []

  // Validate core message structure — always validate the FULL incoming array.
  const msgValidation = ChatRequestSchema.pick({ messages: true }).safeParse({ messages })
  if (!msgValidation.success) {
    return NextResponse.json({ error: 'Messages array required', details: msgValidation.error.issues }, { status: 400 })
  }

  // Conversation persistence (Phase 2): opt-in per request via a client-minted
  // chatId. Invalid shapes are DROPPED, not rejected — persistence is an
  // enhancement and must never 400 a chat that would otherwise work.
  const userEmail = session.user.email ?? null
  const chatId =
    typeof body.chatId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.chatId) && userEmail ? body.chatId : null
  const persistCtx = chatId && userEmail ? { chatId, userEmail } : undefined
  if (persistCtx) {
    // Last user turn in the raw array (the message this request is answering).
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    if (lastUser?.content) {
      void persistUserTurn({
        chatId: persistCtx.chatId,
        userEmail: persistCtx.userEmail,
        messageId: (lastUser as { id?: string }).id ?? null,
        content: lastUser.content,
      })
    }
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
  // The header EXA toggle turns this chat into a two-backend research lane:
  // Exa.AI for the web and the Vertex Semantic Brain for RxFit's own records.
  // Everything else is skipped — pgvector, execution context, Google Workspace
  // context, attachments and skills — then the model synthesizes + cites from
  // whichever backends answered.
  //
  // (This comment previously read "skip Vertex ... run only a forced Exa search",
  // contradicting the Promise.all seven lines below it, which has always run
  // Vertex. lib/gemini.ts:130-139 describes the two-backend behaviour correctly.
  // The stale version is the likeliest reason an agent reading this block
  // concluded Vertex needed "decoupling" from something it was documented as not
  // being part of.)
  if (exaMode) {
    const exaLastUserMsg = boundedMessages.filter(m => m.role === 'user').pop()
    const exaQuery = exaLastUserMsg?.content ?? ''
    log.info({ hasQuery: Boolean(exaQuery) }, 'EXA Search mode active — hybrid semantic pipeline (Exa web + Vertex internal)')

    // Hybrid SEMANTIC-ONLY research: Exa (web) + Vertex AI Internal Brain run
    // CONCURRENTLY, each failing open independently — a Vertex outage must not
    // kill web results and vice versa. Everything else (pgvector, execution context,
    // Workspace context, attachments, skills) stays disabled in this mode —
    // EXCEPT documents the user explicitly linked by URL in their message:
    // those are user-supplied context, not a tool, and refusing to read a link
    // the user just pasted is indistinguishable from a bug to them.
    // ── Deferred assembly (time-to-first-byte) ──
    // This entire three-backend gather now runs INSIDE the stream rather than
    // before it. Response headers cannot exist until streamModelResponse returns,
    // so awaiting this first meant the browser's `fetch` stayed blocked for the
    // whole window — up to the 30s Exa bound — with nothing rendered but a typing
    // dot. Concurrency and every per-branch bound are unchanged; only WHEN this
    // runs relative to the HTTP response moves. See PromptSource above.
    const buildExaPrompt = async (): Promise<SystemPromptParts> => {
      const [exaSearch, internalSearch, exaDriveLinks] = await Promise.all([
        exaQuery ? runExaOnlySearch(exaQuery) : Promise.resolve({ context: '', failed: false }),
        exaQuery
          ? withTimeout(
              (async () => {
                try {
                  const vertexResults = await breaker.execute('vertex-ai', () => searchSemanticBrain(exaQuery))
                  if (vertexResults.length > 0) {
                    const ctx = vertexResults
                      .map(r => `**${r.title}** ${r.uri ? `(${r.uri})` : ''}\n${r.snippet}`)
                      .join('\n\n---\n\n')
                    return { context: ctx, failed: false }
                  }
                  return { context: '', failed: false } // genuinely zero matches
                } catch (err) {
                  // failed:true is the anti-hallucination signal — it becomes a
                  // prompt instruction telling the model to say the Internal Brain
                  // was unavailable and NEVER to invent documents. Unavailability
                  // must never reach the prompt as "zero matches": reporting it that
                  // way is what made the model tell users their documents
                  // don't exist. `[]` (genuinely empty) is the only case that
                  // returns failed:false below.
                  if (err instanceof CircuitOpenError) {
                    log.warn({ key: 'vertex-ai' }, 'Vertex circuit OPEN — EXA hybrid runs web-only')
                  } else if (err instanceof VertexUnavailableError) {
                    log.warn({ reason: err.reason, status: err.status }, 'EXA hybrid: Vertex unavailable — disclosing as failed, not empty')
                  } else {
                    log.warn({ err }, 'EXA hybrid: Vertex internal search failed — web-only')
                  }
                  return { context: '', failed: true }
                }
              })(),
              EXA_VERTEX_BRANCH_MS,
              { context: '', failed: true },
              'exa-internal-search',
            )
          : Promise.resolve({ context: '', failed: false }),
        withTimeout(
          (async () => {
            const tokenState = await resolveGoogleAccessTokenLenient(req)
            return resolveDriveLinkContext(
              exaQuery,
              tokenState.ok ? tokenState.accessToken : undefined,
              tokenState.ok ? undefined : { unavailableReason: tokenState.reason },
            )
          })(),
          DRIVE_LINKS_BRANCH_MS,
          { content: '', advisory: '' },
          'exa-drive-links',
        ),
      ])

      // Parts form → Claude puts a cache breakpoint on the static prefix
      // (persona + policy) so repeat EXA turns read it at 0.1x input price.
      return buildSystemPromptParts({
        injectedContext: exaSearch.context || undefined,
        // The read tools are off in this mode, but they EXIST — the manifest says
        // so and tells the model to point at the EXA toggle rather than denying
        // the capability. Built from the registry alone (no prefs read), so it
        // adds no latency to the EXA path.
        capabilityManifest: buildCapabilityManifest({
          role: chatRole,
          prefsKnown: false,
          unavailable: 'exa-mode',
        }),
        exaMode: true,
        exaSearchFailed: exaSearch.failed,
        exaInternalContext: internalSearch.context || undefined,
        exaInternalFailed: internalSearch.failed,
        driveLinkContext: exaDriveLinks.content || undefined,
        driveLinkAdvisory: exaDriveLinks.advisory || undefined,
      })
    }

    // 'exa_search' routes to the Claude chain (Fable 5 → Sonnet 4.6 → Gemini
    // fallbacks) — research synthesis with citations needs the strongest model,
    // not the Gemini Flash default that plain no-skill deep_dive falls to.
    return streamModelResponse(boundedMessages, buildExaPrompt, 'exa_search', false, req, persistCtx, EXA_ASSEMBLY_STATUS)
  }

  // ── Parallel pre-stream context assembly ──
  // The Hub's own execution context (ai_runs / actions / deep runs /
  // dispatch — 4s timeout) and Google Workspace context (6s timeout) run
  // concurrently via Promise.all. The execution branch replaced the retired
  // Paperclip fetch (Phase 4 PR 1): that branch spent up to 8s failing
  // against a dead upstream and then told the model orchestration data was
  // "warming up", which the model dutifully repeated to the user.
  //
  // The Google OAuth token is resolved first since it's a local JWT decode
  // (sub-ms) that both the Google WS fetch and attachment handling need.
  const chatIsAdmin = canAccessAdminRoute(chatRole)

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

  // Search depends only on the query + useCase (not on execution/Google context),
  // so kick it off NOW to run CONCURRENTLY with the context fetches below.
  const effectiveUseCase = activeSkill ? 'deep_dive' : useCase
  const lastUserMsg = boundedMessages.filter(m => m.role === 'user').pop()
  const query = lastUserMsg?.content ?? ''
  // Read-tool resolution (analytics + Drive/Chat lookups) is independent of the
  // execution/Google context fetches, so start it here to run concurrently
  // rather than adding its latency on top. Resolves to an empty result for
  // questions that need no lookup.
  const readToolsPromise = resolveReadTools(query, chatRole, googleAccessToken)

  const searchPromise: Promise<string[]> = query
    ? runSearchPipeline(query, effectiveUseCase)
    : Promise.resolve([])

  const [executionContextResult, googleWsResult] = await Promise.all([
    // Branch 1: Hub-native execution context (4s timeout). Scoped to the
    // caller: admins see the runs ledger + dispatch rail, everyone sees their
    // own AI actions and deep runs. readExecutionSnapshot never throws — a
    // plane that fails reads as a notice inside the snapshot.
    withTimeout(
      readExecutionSnapshot({ userEmail: session.user.email ?? '', isAdmin: chatIsAdmin })
        .then((snap) => ({ executionContext: formatExecutionContext(snap), executionNotice: undefined as string | undefined }))
        .catch((err: unknown) => {
          log.warn({ err }, 'Execution context read failed — proceeding without it')
          return { executionContext: '', executionNotice: EXECUTION_CONTEXT_FAILED }
        }),
      4_000,
      { executionContext: '', executionNotice: EXECUTION_CONTEXT_TIMED_OUT },
      'execution-context',
    ),

    // Branch 2: Google Workspace context (6s timeout) — runs in parallel.
    //
    // A timeout or fetch error used to resolve to plain `null`, exactly like
    // "no Google session" — so the whole Live Google Workspace section simply
    // vanished with nothing said about it. The model then had no way to tell a
    // BROKEN lookup from an unwired one and answered "you have no upcoming
    // events" to a user with a full calendar. The outcome is now tagged so the
    // prompt can state which it was.
    googleAccessToken
      ? withTimeout<WorkspaceContextOutcome>(
          // The Chat section of this context honors the user's space visibility
          // preferences, so the model sees their real spaces instead of a wall
          // of auto-created Meet conversations. Fail-open to defaults.
          getChatSpacePreferences(session.user.email ?? '')
            .then(prefs => buildGoogleWorkspaceContext(googleAccessToken, prefs))
            .then(ctx => ({ ok: true as const, ...ctx }))
            .catch((err: unknown) => {
            log.warn({ err }, 'Google Workspace context fetch failed — proceeding without it')
            return { ok: false as const, reason: 'error' as const }
          }),
          6_000,
          { ok: false, reason: 'timeout' },
          'google-workspace-context',
        )
      : Promise.resolve<WorkspaceContextOutcome>({ ok: false, reason: 'no-session' }),
  ])

  const { executionContext, executionNotice } = executionContextResult

  let googleWorkspaceDetail: string | undefined
  let googleWorkspaceCounts: { taskCount?: number; upcomingEvents?: number; recentFiles?: number; unreadEmails?: number } = {}
  let googleWorkspaceNotice: string | undefined
  if (googleWsResult.ok) {
    googleWorkspaceDetail = googleWsResult.detail
    googleWorkspaceCounts = googleWsResult.counts
  } else if (googleWsResult.reason !== 'no-session') {
    // 'no-session' is already explained by googleAuthNotice above; saying it
    // twice in different words would be worse than saying it once.
    googleWorkspaceNotice =
      googleWsResult.reason === 'timeout'
        ? '[The live Google Workspace lookup TIMED OUT this turn, so the "Live Google Workspace" section below is absent. The user\'s Google account IS connected and their Tasks, Calendar, Drive, Gmail and Chat data DOES exist — the Hub just could not fetch it in time. If they ask about it, say the lookup timed out and invite them to retry or use the left panel. NEVER say they have no tasks, no events, no files, or no mail, and never invent any.]'
        : '[The live Google Workspace lookup FAILED this turn, so the "Live Google Workspace" section below is absent. The user\'s Google account IS connected and their data DOES exist — the fetch errored. If they ask about it, say the lookup failed and invite them to retry or use the left panel. NEVER say they have no tasks, no events, no files, or no mail, and never invent any.]'
  }

  const searchResults = await searchPromise
  const searchContext = searchResults.join('')

  // Resolve attachments into text context. Extracted to resolveAttachmentContext
  // (lib/attachment-resolver.ts), which resolves the (independent) attachments
  // CONCURRENTLY — preserving the .slice(0,5) cap, input order of the injected
  // blocks, per-attachment error isolation, and every existing timeout. This cuts
  // worst-case time-to-first-token from serial (~30-40s for 3-5 items) to parallel.
  const [attachmentContext, driveLinks] = await Promise.all([
    // Record attachments (right-panel card taps) resolve inside the caller's
    // own scope — the role decides whether the runs ledger is readable.
    resolveAttachmentContext(attachments, lastUserMsg, googleAccessToken, {
      userEmail: session.user.email ?? '',
      role: chatRole,
    }),
    // Drive links pasted directly into the message text — read with the
    // user's token, deterministically (no planner in the loop).
    resolveDriveLinkContext(
      query,
      googleAccessToken,
      googleTokenState.ok ? undefined : { unavailableReason: googleTokenState.reason },
    ),
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
    executionContext: executionContext || undefined,
    executionNotice,
    googleWorkspace: Object.keys(googleWorkspaceCounts).length > 0 ? googleWorkspaceCounts : undefined,
    googleWorkspaceDetail,
    googleAuthNotice,
    googleWorkspaceNotice,
    liveAnalytics: liveAnalytics.context,
    capabilityManifest: liveAnalytics.manifest,
    injectedContext: allInjectedContext || undefined,
    driveLinkContext: driveLinks.content || undefined,
    driveLinkAdvisory: driveLinks.advisory || undefined,
    activeSkill: activeSkill || undefined,
    activeSkillContent,
  })

  // effectiveUseCase already computed above (before search routing) for consistency

  // Stream response (shared with the EXA Search path — see streamModelResponse).
  return streamModelResponse(boundedMessages, systemPrompt, effectiveUseCase, Boolean(activeSkill), req, persistCtx)
}

/**
 * The route boundary. handleChat throws on any pre-stream failure and withFault
 * turns that into the fault response: a HUB- id in `x-hub-fault-id` and in the
 * body's `instance`, a record in Error Reporting, and — the part a hand-rolled
 * catch could not get right — the SAME requestId in the record and on the
 * response.
 *
 * That last point is why this delegates rather than catching. /api/chat is
 * middleware-EXCLUDED, so no inbound x-hub-request-id exists; a catch calling
 * safeRequestId() mints a SECOND id, and the fault is then recorded under an id
 * that appears nowhere in the response. Measured before this was written: the
 * record read 44b6abe7-… while the response header read d8dd8c23-…, so a user
 * quoting the id they were given found nothing in the logs. One derivation,
 * withFault's, is the only way that stays true.
 *
 * lib/chat-error.ts is deleted with this. faultResponse generalizes it (§5
 * called it "the repo's only NODE_ENV-gated error body") and emits both keys
 * useChatEngine reads — it takes `details`, falling back to `error`. Once stream
 * frames are flushed the wrapper can no longer change the response; that
 * terminal-frame contract is Phase 5, and the in-stream error frame still
 * handles it.
 */
export const POST = withFault('chat', handleChat)
