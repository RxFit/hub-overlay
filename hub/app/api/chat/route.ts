import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
import { streamGeminiChat, buildSystemPrompt } from '@/lib/gemini'
import { getCompanies, getIssues, getRuns } from '@/lib/paperclip'
import { fetchUrlContent, fetchDriveDocContent } from '@/lib/content-fetch'
import { searchSemanticBrain } from '@/lib/vertex'
import type { ChatMessage, ChatAttachment } from '@/types'

export const runtime = 'nodejs'
export const maxDuration = 60

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
          // Fetch URL content server-side
          const urlText = await fetchUrlContent(att.url)
          resolvedParts.push(
            `### Attached URL: ${att.url}\n\n${urlText}`
          )
        } else if (att.type === 'document' && att.fileId) {
          // Hybrid: try Vertex AI semantic search first, fall back to Drive API
          let docText: string | null = null

          // Attempt Vertex AI semantic search (token-efficient)
          const lastUserMsg = messages.filter(m => m.role === 'user').pop()
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

  const systemPrompt = buildSystemPrompt({
    projects: projectContext,
    agentActivity,
    injectedContext: attachmentContext || undefined,
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
