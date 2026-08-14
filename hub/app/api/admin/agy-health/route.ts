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
import { recordAiRun } from '@/lib/runs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// A live probe is a real model run, and on a cold instance it is ALSO a ~55MB
// download plus a ~206MB extract before the prompt starts (the binary
// provisions itself on first use). Those two costs are sequential and the
// install is not covered by agyGenerateText's own timeout, so a chat-sized
// 120s ceiling could kill the request mid-install — surfacing as a dead
// connection with no errorClass instead of the typed error the probe exists to
// report. 300s matches the Cloud Run service ceiling (service.yaml
// timeoutSeconds), which is the real outer bound.
export const maxDuration = 300

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
    const probePrompt = `Reply with exactly this token and nothing else: ${PROBE_MARKER}`
    try {
      const result = await agyGenerateText(probePrompt, {
        timeoutMs: 90_000,
      })
      const markerVerified = result.text.includes(PROBE_MARKER)
      probe = {
        ran: true,
        ok: true,
        // A reply without the marker still proves auth replayed; report both.
        markerVerified,
        model: result.model,
        cacheReadTokens: result.usage?.cacheReadTokens,
        latencyMs: result.latencyMs,
      }
      // Ledger (Phase 2): probes are real allotment spend and the very runs
      // that decide go/no-go — they belong on the record. Awaited because the
      // probe path is not latency-sensitive; recordAiRun never throws.
      await recordAiRun({
        engine: 'agy',
        model: result.model,
        source: 'health_probe',
        status: 'ok',
        latencyMs: result.latencyMs,
        prompt: probePrompt,
        usage: result.usage,
        userEmail: user.email,
        meta: { markerVerified },
      })
    } catch (err) {
      const errorClass = agyErrorType(err)
      const error = truncateAgyError(err)
      const latencyMs = Date.now() - start
      probe = { ran: true, ok: false, errorClass, error, latencyMs }
      await recordAiRun({
        engine: 'agy',
        source: 'health_probe',
        status: 'error',
        errorClass,
        error,
        latencyMs,
        prompt: probePrompt,
        userEmail: user.email,
      })
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
