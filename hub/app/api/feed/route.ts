import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getCompanies, getIssues, getAgents } from '@/lib/paperclip'
import type { FeedItem } from '@/types'

export const runtime = 'nodejs'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const feed: FeedItem[] = []

  try {
    const companies = await getCompanies()

    // Fetch recent issues and agents from all companies
    const companySlice = companies.slice(0, 6) // cover all orgs

    const [issueResults, agentResults] = await Promise.all([
      Promise.all(
        companySlice.map((c) =>
          getIssues(c.id, { limit: 10 }).catch(() => [])
        )
      ),
      Promise.all(
        companySlice.map((c) =>
          getAgents(c.id).catch(() => [])
        )
      ),
    ])

    // Convert issues to feed items
    for (const issue of issueResults.flat()) {
      const feedType = issue.state?.group === 'completed' ? 'completed' as const
        : issue.state?.group === 'started' ? 'in_progress' as const
        : (issue.priority === 'urgent' || issue.priority === 'high') ? 'needs_you' as const
        : 'info' as const

      feed.push({
        id: `issue-${issue.id}`,
        source: 'paperclip',
        type: feedType,
        title: `[${issue.identifier}] ${issue.title}`,
        description: `Status: ${issue.state?.name ?? 'unknown'} · Priority: ${issue.priority}`,
        timestamp: issue.updatedAt,
        icon: 'alert-circle',
        metadata: {
          issueId: issue.id,
          state: issue.state?.group,
          priority: issue.priority,
        },
      })
    }

    // Convert agents to feed items (show active/errored agents)
    for (const agent of agentResults.flat()) {
      const agentType = agent.status === 'active' ? 'in_progress' as const
        : agent.status === 'error' ? 'needs_you' as const
        : 'info' as const

      feed.push({
        id: `agent-${agent.id}`,
        source: 'paperclip',
        type: agentType,
        title: `Agent: ${agent.name || 'Unnamed'}`,
        description: `Adapter: ${agent.adapter ?? 'n/a'} · Status: ${agent.status ?? 'unknown'}`,
        timestamp: agent.lastHeartbeat ?? agent.createdAt ?? new Date().toISOString(),
        icon: 'cpu',
        metadata: {
          agentId: agent.id,
          status: agent.status,
          agentName: agent.name,
        },
      })
    }

    // Sort by timestamp descending (newest first)
    feed.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  } catch (err) {
    // Paperclip unavailable — return empty feed with system message
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.warn('[feed] Paperclip unavailable:', message)
    feed.push({
      id: 'system-offline',
      source: 'system',
      type: 'info',
      title: 'Paperclip Unavailable',
      description: 'Could not connect to the Paperclip API. Activity feed will resume when the connection is restored.',
      timestamp: new Date().toISOString(),
      icon: 'alert-triangle',
    })
  }

  return NextResponse.json({ feed })
}
