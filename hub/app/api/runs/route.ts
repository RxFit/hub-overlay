import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessAdminRoute } from '@/lib/roles'
import { listAiRuns } from '@/lib/runs'
import { listAiActions } from '@/lib/ai-audit'
import { aiActionToFeedItem } from '@/lib/ai-action-feed'
import { runToFeedItem } from '@/lib/run-feed'
import type { FeedItem } from '@/types'
import { withFault } from '@/lib/route-fault'
import { emptyOn } from '@/lib/swallow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/runs — the right panel's execution feed
 * (Phase 3 PR 2, docs/architecture/PHASE3_EXECUTION_PANEL_2026-08-22.md §4).
 *
 * Serves the `ai_runs` ledger mapped to the existing FeedItem contract,
 * merged with the caller's own recent AI actions (the one live source the
 * Paperclip-era feed had — carried over, same shape, so provenance the
 * operator already relies on does not vanish in the source swap).
 *
 * ADMIN-GATED (§3.4): chat ledger rows carry no user attribution yet, so
 * there is no safe way to scope a staff view to their own runs. Staff get
 * 403; the client knows the role and renders a quiet admin-only state
 * without calling. Ledger attribution is the named follow-up that opens
 * this to staff as a filter.
 *
 * The run rows are provenance-only by ledger contract (prompts are length +
 * sha256, never text), and the run mapper additionally withholds `error`
 * message text — run cards show typed error classes only. The merged
 * ai_action rows keep their existing aiActionToFeedItem shape unchanged
 * (pre-existing contract; the caller sees only their own actions).
 */

const DEFAULT_LIMIT = 40
const MAX_LIMIT = 100

export const GET = withFault('runs', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canAccessAdminRoute(user.role)) {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })
  }

  const rawLimit = Number.parseInt(req.nextUrl.searchParams.get('limit') ?? '', 10)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT

  // Both reads are independent; the actions read is best-effort so a
  // hiccup there cannot blank the runs feed (mirrors /api/feed's posture).
  const [runs, actions] = await Promise.all([
    listAiRuns({ limit }),
    listAiActions({ userEmail: user.email, limit: 15 }).catch((err: unknown) =>
      emptyOn(err, { module: 'api/runs', op: 'listAiActions' }, []),
    ),
  ])

  const feed: FeedItem[] = [
    ...runs.map(runToFeedItem),
    ...actions.map(aiActionToFeedItem),
  ]
  feed.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  return NextResponse.json({ feed })
})
