import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { streamChat, buildSystemPrompt } from '@/lib/gemini'
import { getCompanies, getIssues, getAgents, getRuns } from '@/lib/paperclip'
import { fetchUrlContent, fetchDriveDocContent } from '@/lib/content-fetch'
import { searchSemanticBrain } from '@/lib/vertex'
import { searchWeb, fetchUrlWithExa } from '@/lib/exa'
import { loadSkillContent } from '@/lib/skills-loader'
import { needsInternalSearch, needsExternalSearch } from '@/lib/search-routing'
import { ChatRequestSchema } from '@/lib/zod-schemas'
import { buildGoogleWorkspaceContext } from '@/lib/google-context'
import { withTimeout } from '@/lib/timeout'
import { breaker, CircuitOpenError } from '@/lib/circuit-breaker'
import type { ChatMessage, ChatAttachment } from '@/types'

const log = createLogger('chat')

export const runtime = 'nodejs'
export const maxDuration = 120

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
        const shouldRunVertex = effectiveUseCase === 'deep_dive' || effectiveUseCase === 'interview' || (effectiveUseCase === 'execute' && explicitInternalReq)
        const shouldRunPgVector = effectiveUseCase === 'recall' || effectiveUseCase === 'deep_dive' || effectiveUseCase === 'interview' || (effectiveUseCase === 'execute' && explicitInternalReq)

        log.info({ effectiveUseCase, shouldRunVertex, shouldRunPgVector, explicitInternalReq }, 'Search routing decision')

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

export async function POST(req: NextRequest) {
  // Auth check
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { messages: ChatMessage[]; useCase?: string; attachments?: ChatAttachment[]; activeSkill?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { messages, useCase = 'deep_dive', attachments, activeSkill } = body

  // Validate core message structure
  const msgValidation = ChatRequestSchema.pick({ messages: true }).safeParse({ messages })
  if (!msgValidation.success) {
    return NextResponse.json({ error: 'Messages array required', details: msgValidation.error.issues }, { status: 400 })
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

  const googleToken = await getToken({ req })
  const googleAccessToken = googleToken?.accessToken as string | undefined

  // Search depends only on the query + useCase (not on Paperclip/Google context),
  // so kick it off NOW to run CONCURRENTLY with the context fetches below.
  const effectiveUseCase = activeSkill ? 'deep_dive' : useCase
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()
  const query = lastUserMsg?.content ?? ''
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
          buildGoogleWorkspaceContext(googleAccessToken).catch((err) => {
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
  let googleWorkspaceCounts: { taskCount?: number; upcomingEvents?: number; recentFiles?: number } = {}
  if (googleWsResult) {
    googleWorkspaceDetail = googleWsResult.detail
    googleWorkspaceCounts = googleWsResult.counts
  }

  const searchResults = await searchPromise
  const searchContext = searchResults.join('')

  // Resolve attachments into text context
  let attachmentContext = ''
  if (attachments && attachments.length > 0) {
    const accessToken = googleAccessToken

    const resolvedParts: string[] = []

    for (const att of attachments.slice(0, 5)) {  // Cap at 5
      try {
        if (att.type === 'text' && att.content) {
          // Direct text — use as-is
          resolvedParts.push(
            `### Attached Text: "${att.label}"\n\n${att.content.slice(0, 16_000)}`
          )
        } else if (att.type === 'url' && att.url) {
          // Try Exa.AI first (handles JS-heavy pages), fall back to raw fetch
          let urlText: string | undefined
          try {
            urlText = await fetchUrlWithExa(att.url)
          } catch {
            // Exa unavailable or failed
          }
          if (!urlText?.trim()) {
            urlText = await fetchUrlContent(att.url)
          }
          resolvedParts.push(
            `### Attached URL: ${att.url}\n\n${urlText}`
          )
        } else if (att.type === 'document' && att.fileId) {
          // Vertex AI semantic search first (token-efficient), Drive API fallback
          let docText: string | null = null

          // Attempt Vertex AI semantic search for the document
          if (lastUserMsg) {
            const vertexResults = await searchSemanticBrain(
              `${lastUserMsg.content} ${att.label}`,
              'rxfit-gdrive'
            )
            if (vertexResults && vertexResults.length > 0) {
              docText = vertexResults
                .map(r => `**${r.title}**\n${r.snippet}`)
                .join('\n\n---\n\n')
              docText = `[Retrieved via Semantic Brain]\n\n${docText}`
            }
          }

          // Fallback: direct Drive API export
          if (!docText && accessToken) {
            docText = await fetchDriveDocContent(accessToken, att.fileId, att.mimeType)
          }

          resolvedParts.push(
            `### Attached Document: "${att.label}"\n\n${docText ?? '[Unable to retrieve document content]'}`
          )
        }
      } catch (err) {
        log.error({ err, label: att.label }, 'Failed to resolve attachment')
        resolvedParts.push(
          `### Attached: "${att.label}"\n\n[Failed to load content]`
        )
      }
    }

    if (resolvedParts.length > 0) {
      attachmentContext = `## User-Attached Context\n\nThe user has attached the following ${resolvedParts.length} item(s) to their message. Use this content to inform your response.\n\n${resolvedParts.join('\n\n---\n\n')}`
    }
  }

  // Combine all injected context
  const allInjectedContext = [searchContext, attachmentContext].filter(Boolean).join('\n\n')

  // Load active skill content if specified
  let activeSkillContent: string | undefined
  if (activeSkill) {
    const content = await loadSkillContent(activeSkill)
    if (content) activeSkillContent = content
  }

  const systemPrompt = buildSystemPrompt({
    projects: projectContext,
    agentActivity,
    googleWorkspace: Object.keys(googleWorkspaceCounts).length > 0 ? googleWorkspaceCounts : undefined,
    googleWorkspaceDetail,
    injectedContext: allInjectedContext || undefined,
    activeSkill: activeSkill || undefined,
    activeSkillContent,
  })

  // effectiveUseCase already computed above (before search routing) for consistency

  // Stream response
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      try {
        let fullText = ''
        const hasActiveSkill = Boolean(activeSkill)
        for await (const chunk of streamChat(messages, systemPrompt, effectiveUseCase, hasActiveSkill)) {
          if (typeof chunk === 'object' && 'modelUsed' in chunk) {
            // Emit model identification event to the UI
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ modelUsed: chunk.modelUsed })}\n\n`))
            continue
          }
          fullText += chunk
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`))
        }

        // Parse suggestedTools metadata from AI response
        const toolMatch = fullText.match(/<!--suggestedTools:(\[.*?\])-->/)
        if (toolMatch) {
          try {
            const tools = JSON.parse(toolMatch[1])
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ suggestedTools: tools })}\n\n`))
          } catch {
            // Skip malformed suggestedTools
          }
        }

        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`))
      } finally {
        controller.close()
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
