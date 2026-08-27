import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessAdminRoute } from '@/lib/roles'
import { db } from '@/lib/db'
import { eventLog, aiActionLog } from '@/lib/schema'
import { and, gte, like } from 'drizzle-orm'
import { computeAiHealth, type TelemetryRow, type ActionRow, type ProviderConfig } from '@/lib/ai-health'
import { isGeminiConfigured } from '@/lib/gemini'
import { isClaudeConfigured } from '@/lib/claude'

export const runtime = 'nodejs'

/**
 * GET /api/admin/ai-health — AI Health aggregate for the admin dashboard (NS-10).
 *
 * Admin/superadmin ONLY. The middleware guards /admin PAGES but not
 * /api/admin/*, so this route enforces the role itself via canAccessAdminRoute
 * (defense in depth: 401 unauthenticated, 403 non-admin).
 *
 * `?window=1h|24h|7d` (default 24h, whitelist — anything else is a 400) bounds
 * the query: persisted telemetry rows (`event_log` where eventType LIKE
 * 'telemetry:%') plus `ai_action_log` rows since the cutoff are fetched and
 * aggregated by the pure lib/ai-health computeAiHealth. Percentiles are
 * computed in JS — single-tenant volumes are small and the sink caps writes at
 * ~2 rows/request, so fetching the window is cheap.
 *
 * NOTE: the (event_type, created_at) index this read wants EXISTS —
 * `event_log_type_created_idx`, lib/schema.ts — so the window query is
 * index-served. (An earlier version of this comment claimed it was missing.)
 */

const WINDOW_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canAccessAdminRoute(user.role)) {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })
  }

  const windowParam = req.nextUrl.searchParams.get('window') ?? '24h'
  const windowMs = WINDOW_MS[windowParam]
  if (!windowMs) {
    return NextResponse.json(
      { error: 'Invalid window — expected one of 1h, 24h, 7d' },
      { status: 400 },
    )
  }

  const since = new Date(Date.now() - windowMs)

  try {
    const [telemetryRows, actionRows] = await Promise.all([
      db
        .select({
          eventType: eventLog.eventType,
          payload: eventLog.payload,
          createdAt: eventLog.createdAt,
        })
        .from(eventLog)
        .where(and(like(eventLog.eventType, 'telemetry:%'), gte(eventLog.createdAt, since))),
      db
        .select({
          actionType: aiActionLog.actionType,
          status: aiActionLog.status,
          error: aiActionLog.error,
          createdAt: aiActionLog.createdAt,
        })
        .from(aiActionLog)
        .where(gte(aiActionLog.createdAt, since)),
    ])

    const health = computeAiHealth(
      telemetryRows as TelemetryRow[],
      actionRows as ActionRow[],
      windowMs,
    )
    // Key PRESENCE booleans only (never values/lengths/prefixes) — the
    // one-glance answer to the chat bubble's "provider configuration" error.
    // See docs/runbooks/ai-provider-outage.md.
    const providerConfig: ProviderConfig = {
      gemini: isGeminiConfigured(),
      anthropic: isClaudeConfigured(),
    }
    return NextResponse.json({
      window: windowParam,
      generatedAt: new Date().toISOString(),
      providerConfig,
      ...health,
    })
  } catch (err) {
    console.error('[api/admin/ai-health GET]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to compute AI health' }, { status: 500 })
  }
}
