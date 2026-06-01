import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
import { streamGeminiChat, buildSystemPrompt } from '@/lib/gemini'
import { getCompanies, getIssues, getRuns } from '@/lib/paperclip'
import { fetchUrlContent, fetchDriveDocContent } from '@/lib/content-fetch'
import { searchSemanticBrain } from '@/lib/vertex'
import { searchWeb, fetchUrlWithExa } from '@/lib/exa'
import type { ChatMessage, ChatAttachment } from '@/types'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Detect if a user message likely needs external web data.
 * Returns true for queries about public info, competitors, news, markets, etc.
 */
function needsExternalSearch(message: string): boolean {
  const lower = message.toLowerCase()
  const externalSignals = [
    // Explicit web/research signals
    'search for', 'look up', 'find out', 'google', 'research',
    'what is', 'who is', 'what are', 'how to', 'how does',
    // Competitor/market signals
    'competitor', 'market', 'industry', 'trend', 'pricing',
    'benchmark', 'comparison', 'compare',
    // News/current events
    'news', 'latest', 'recent', 'update', 'announce', 'launch',
    'today', 'this week', 'this month',
    // Technical/external docs
    'documentation', 'docs', 'api', 'tutorial', 'guide',
    'best practice', 'standard', 'specification',
    // Named external entities (common patterns)
    'http://', 'https://', '.com', '.io', '.org', '.ai',
    // Analysis that needs outside data
    'seo', 'rankings', 'traffic', 'social media',
    'reviews', 'feedback', 'public opinion',
  ]
  return externalSignals.some(signal => lower.includes(signal))
}

export async function POST(req: NextRequest) {
  // Auth check
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { messages: ChatMessage[]; useCase?: string; attachments?: ChatAttachment[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { messages, useCase = 'deep_dive', attachments } = body
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'Messages array required' }, { status: 400 })
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
  } catch {
    // Paperclip unavailable — proceed without context
    projectContext = 'Paperclip API unavailable — using cached context'
  }

  // ── Intelligent Search Routing ──
  // Vertex AI → internal data (Google Drive, Gmail, Chat)
  // Exa.AI   → external data (web, competitors, news, public URLs)
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()
  let searchContext = ''

  if (lastUserMsg) {
    const query = lastUserMsg.content

    // Run searches in parallel based on query intent
    const searchPromises: Promise<void>[] = []

    // Always try Vertex AI for internal context (lightweight, always useful)
    searchPromises.push(
      (async () => {
        try {
          const vertexResults = await searchSemanticBrain(query)
          if (vertexResults && vertexResults.length > 0) {
            const vertexContext = vertexResults
              .map(r => `**${r.title}** ${r.uri ? `(${r.uri})` : ''}\n${r.snippet}`)
              .join('\n\n---\n\n')
            searchContext += `## Internal Knowledge (Vertex AI — Google Drive/Workspace)\n\n${vertexContext}\n\n`
          }
        } catch (err) {
          console.warn('[chat] Vertex AI search failed:', err)
        }
      })()
    )

    // Use Exa.AI for external queries
    if (needsExternalSearch(query)) {
      searchPromises.push(
        (async () => {
          try {
            const exaResults = await searchWeb(query, {
              numResults: 5,
              useAutoprompt: true,
            })
            if (exaResults && exaResults.length > 0) {
              const exaContext = exaResults
                .map(r => {
                  let entry = `**${r.title}** — [${r.url}]`
                  if (r.publishedDate) entry += ` (${r.publishedDate.split('T')[0]})`
                  entry += `\n${r.snippet}`
                  return entry
                })
                .join('\n\n---\n\n')
              searchContext += `## External Web Research (Exa.AI)\n\n${exaContext}\n\n`
            }
          } catch (err) {
            console.warn('[chat] Exa.AI search failed:', err)
          }
        })()
      )
    }

    await Promise.all(searchPromises)
  }

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
          let urlText: string | null = null
          try {
            urlText = await fetchUrlWithExa(att.url)
          } catch {
            // Exa unavailable
          }
          if (!urlText) {
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
        console.error(`[chat] Failed to resolve attachment "${att.label}":`, err)
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

  const systemPrompt = buildSystemPrompt({
    projects: projectContext,
    agentActivity,
    injectedContext: allInjectedContext || undefined,
  })

  // Stream response
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamGeminiChat(messages, systemPrompt, useCase)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`))
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
