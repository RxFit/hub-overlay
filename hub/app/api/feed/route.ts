import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getCompanies, getIssues, getRuns } from '@/lib/paperclip'
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

    // Fetch recent issues and runs from all companies (cap at 3 for perf)
    const companySlice = companies.slice(0, 3)

    const [issueResults, runResults] = await Promise.all([
      Promise.all(
        companySlice.map((c) =>
          getIssues(c.id, { limit: 5 }).catch(() => [])
        )
      ),
      Promise.all(
        companySlice.map((c) =>
          getRuns(c.id, { limit: 5 }).catch(() => [])
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

    // Convert runs to feed items
    for (const run of runResults.flat()) {
      const runType = run.status === 'completed' ? 'completed' as const
        : run.status === 'running' ? 'in_progress' as const
        : run.status === 'failed' ? 'needs_you' as const
        : 'info' as const

      feed.push({
        id: `run-${run.id}`,
        source: 'paperclip',
        type: runType,
        title: `Agent run: ${run.agentName}`,
        description: `Issue ${run.issueIdentifier} · Status: ${run.status}${run.durationMs ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ''}`,
        timestamp: run.startedAt ?? run.completedAt ?? new Date().toISOString(),
        icon: 'cpu',
        metadata: {
          runId: run.id,
          status: run.status,
          agentName: run.agentName,
        },
      })
    }

    // Sort by timestamp descending (newest first)
    feed.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  } catch {
    // Paperclip unavailable — return empty feed with system message
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
