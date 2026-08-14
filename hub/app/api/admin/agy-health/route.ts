import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessAdminRoute } from '@/lib/roles'
import {
  agyGenerateText,
  agyVersion,
  agyErrorType,
  agyTokenSource,
  isAgyConfigured,
  truncateAgyError,
} from '@/lib/agy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// A live probe is a real model run; give it the same ceiling as chat.
export const maxDuration = 120

/**
 * GET /api/admin/agy-health — agy execution-gateway health (Phase 1).
 *
 * Admin/superadmin ONLY (same defense-in-depth as /api/admin/paperclip-health:
 * middleware guards /admin pages but not /api/admin/*, so the role is enforced
 * here — 401 unauthenticated, 403 non-admin).
 *
 * Default response is CHEAP: config presence (booleans only, never values) and
 * a binary version check. Append `?probe=1` to run a real end-to-end prompt on
 * the allotment — the production re-run of the Phase 0 replay test, marker
 * verification included. The probe spends a few tokens, which is why it is
 * opt-in per request.
 */

const PROBE_MARKER = 'AGY_GATEWAY_OK'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canAccessAdminRoute(user.role)) {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })
  }

  const config = {
    configured: isAgyConfigured(),
    tokenSource: agyTokenSource(),
    envTokenPresent: Boolean(process.env.AGY_OAUTH_TOKEN),
    modelPin: process.env.AGY_MODEL || null,
  }

  // Passive check only — the binary provisions itself (checksum-verified) on
  // the first real run, so absence here is normal before first use and does
  // not count against health.
  const version = await agyVersion()
  const binary = version
    ? { found: true as const, version }
    : { found: false as const, note: 'not provisioned yet — installs on first run (or ?probe=1)' }

  let probe:
    | { ran: false }
    | { ran: true; ok: true; markerVerified: boolean; model?: string; cacheReadTokens?: number; latencyMs: number }
    | { ran: true; ok: false; errorClass: string; error: string; latencyMs: number } = { ran: false }

  if (req.nextUrl.searchParams.get('probe') === '1') {
    const start = Date.now()
    try {
      const result = await agyGenerateText(`Reply with exactly this token and nothing else: ${PROBE_MARKER}`, {
        timeoutMs: 90_000,
      })
      probe = {
        ran: true,
        ok: true,
        // A reply without the marker still proves auth replayed; report both.
        markerVerified: result.text.includes(PROBE_MARKER),
        model: result.model,
        cacheReadTokens: result.usage?.cacheReadTokens,
        latencyMs: result.latencyMs,
      }
    } catch (err) {
      probe = {
        ran: true,
        ok: false,
        errorClass: agyErrorType(err),
        error: truncateAgyError(err),
        latencyMs: Date.now() - start,
      }
    }
  }

  const healthy = config.configured && (!probe.ran || probe.ok)
  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    healthy,
    config,
    binary,
    probe,
  })
}
