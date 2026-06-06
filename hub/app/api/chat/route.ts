import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { streamGeminiChat, buildSystemPrompt } from '@/lib/gemini'
import { getCompanies, getIssues, getAgents } from '@/lib/paperclip'
import { fetchUrlContent, fetchDriveDocContent } from '@/lib/content-fetch'
import { searchSemanticBrain } from '@/lib/vertex'
import { searchWeb, fetchUrlWithExa } from '@/lib/exa'
import { loadSkillContent } from '@/lib/skills-loader'
import { ChatRequestSchema } from '@/lib/zod-schemas'
import type { ChatMessage, ChatAttachment } from '@/types'

const log = createLogger('chat')

export const runtime = 'nodejs'
export const maxDuration = 60

const internalSignals = [
  'our ', 'my ', 'kpi', 'paperclip', 'workspace',
  'project status', 'team ', 'sprint', 'issue ',
  'casa trejo', 'rxfit',
]

function needsInternalSearch(message: string): boolean {
  const lower = message.toLowerCase()
  return internalSignals.some(s => lower.includes(s))
}

/**
 * Detect if a user message likely needs external web data.
 * Returns true for queries about public info, competitors, news, markets, etc.
 */
function needsExternalSearch(message: string): boolean {
  const lower = message.toLowerCase()

  // Skip if clearly about internal data
  if (needsInternalSearch(message)) return false

  const externalSignals = [
    // Explicit web/research intent
    'search for', 'search the web', 'look up', 'find out about',
    'google ', 'research ',
    // Knowledge questions
    'what is a ', 'who is ', 'what are ', 'how to ', 'how does ',
    // Competitor/market signals
    'competitor', 'market ', 'industry ', 'trend',
    'benchmark', 'comparison', 'compare with',
    // News/current events (multi-word to avoid false positives)
    'in the news', 'latest news', 'recent announcement',
    // Technical/external docs
    'documentation for', 'docs for', 'tutorial', 'guide for',
    'best practice', 'specification',
    // Named external entities (URLs)
    'http://', 'https://',
    // Analysis that needs outside data
    'seo', 'rankings', 'traffic', 'social media',
    'reviews', 'public opinion',
  ]
  return externalSignals.some(signal => lower.includes(signal))
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

  // Build context from live Paperclip data
  let projectContext = ''
  let agentActivity = ''
  try {
    const companies = await getCompanies()
    projectContext = companies
      .map(c => `- ${c.name} (${c.identifier}): ${c.issueCount ?? '?'} issues, ${c.memberCount ?? '?'} members`)
      .join('\n')

    // Get recent issues across all companies (first 3 for context)
    const issuePromises = companies.slice(0, 3).map(c =>
      getIssues(c.id, { limit: 5 }).catch(() => [])
    )
    const issueResults = await Promise.all(issuePromises)
    const allIssues = issueResults.flat()
    agentActivity = allIssues
      .slice(0, 10)
      .map(i => `- [${i.identifier}] ${i.title} (${i.state?.name ?? 'unknown'})`)
      .join('\n')

    // Also get agent status for system prompt context
    let agentStatusContext = ''
    try {
      const agentPromises = companies.slice(0, 3).map(c =>
        getAgents(c.id).catch(() => [])
      )
      const agentResults = await Promise.all(agentPromises)
      const allAgents = agentResults.flat()
      const healthy = allAgents.filter(a => a.status === 'active').length
      const errored = allAgents.filter(a => a.status === 'error').length
      const inactive = allAgents.filter(a => a.status === 'inactive').length
      agentStatusContext = `Agent Fleet Status: ${allAgents.length} total — ${healthy} healthy, ${errored} errored, ${inactive} inactive`
    } catch {
      // Agents unavailable
    }
    if (agentStatusContext) {
      agentActivity += '\n' + agentStatusContext
    }
  } catch {
    // Paperclip unavailable — proceed without context
    projectContext = 'Paperclip API unavailable — using cached context'
  }

  const effectiveUseCase = activeSkill ? 'deep_dive' : useCase

  // ── Intelligent Search Routing ──
  // Vertex AI → internal data (Google Drive, Gmail, Chat)
  // pgvector → Obsidian semantic database
  // Exa.AI   → external data (web, competitors, news, public URLs)
  //
  // Routing matrix (effectiveUseCase × intent):
  //   recall    → pgvector only (fast recall from Obsidian)
  //   deep_dive → Vertex AI + pgvector (full internal context)
  //   interview → Vertex AI + pgvector (needs context for smart questions)
  //   execute   → skip unless query explicitly references internal data
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()
  const searchContextParts: string[] = []

  if (lastUserMsg) {
    const query = lastUserMsg.content

    // Run searches in parallel based on query intent
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
            const vertexResults = await searchSemanticBrain(query)
            if (vertexResults && vertexResults.length > 0) {
              const vertexContext = vertexResults
                .map(r => `**${r.title}** ${r.uri ? `(${r.uri})` : ''}\n${r.snippet}`)
                .join('\n\n---\n\n')
              return `## Internal Knowledge (Vertex AI — Google Drive/Workspace)\n\n${vertexContext}\n\n`
            }
          } catch (err) {
            log.warn({ err }, 'Vertex AI search failed')
          }
          return null
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
            const tenantId = process.env.NEXT_PUBLIC_TENANT_ID || 'rxfit'
            const { searchSimilarDocuments } = await import('@/lib/vector-store')
            const pgvectorResults = await searchSimilarDocuments(tenantId, query, 3)
            
            if (pgvectorResults && pgvectorResults.length < 3) {
              log.info({ count: pgvectorResults.length }, 'Few chunks met relevance threshold (0.65)')
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
            const exaResults = await searchWeb(query, {
              numResults: 5,
              useAutoprompt: true,
            })
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
            log.warn({ err }, 'Exa.AI search failed')
          }
          return null
        })()
      )
    }

    const searchResults = await Promise.all(searchPromises)
    searchContextParts.push(...searchResults.filter((r): r is string => r !== null))
  }

  const searchContext = searchContextParts.join('')

  // Resolve attachments into text context
  let attachmentContext = ''
  if (attachments && attachments.length > 0) {
    const token = await getToken({ req })
    const accessToken = token?.accessToken as string | undefined

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
        for await (const chunk of streamGeminiChat(messages, systemPrompt, effectiveUseCase)) {
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
