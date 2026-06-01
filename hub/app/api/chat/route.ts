import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { streamGeminiChat, buildSystemPrompt } from '@/lib/gemini'
import { getCompanies, getIssues, getRuns } from '@/lib/paperclip'
import type { ChatMessage } from '@/types'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  // Auth check
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { messages: ChatMessage[]; useCase?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { messages, useCase = 'deep_dive' } = body
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

  const systemPrompt = buildSystemPrompt({
    projects: projectContext,
    agentActivity,
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
