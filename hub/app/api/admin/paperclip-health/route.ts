import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessAdminRoute } from '@/lib/roles'
import { getCompanies } from '@/lib/paperclip'
import { getPaperclipAuthHeaders } from '@/lib/paperclipSession'
import { PAPERCLIP_BASE_URL } from '@/lib/paperclipConfig'
import { classifyPaperclipError, truncatePaperclipError as truncate } from '@/lib/paperclip-health'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/**
 * GET /api/admin/paperclip-health — live Paperclip connectivity probe.
 *
 * Admin/superadmin ONLY (same defense-in-depth as /api/admin/ai-health: the
 * middleware guards /admin pages but not /api/admin/*, so the role is
 * enforced here — 401 unauthenticated, 403 non-admin).
 *
 * Answers "why is the right panel dead?" in one request, without Cloud
 * Logging access: it exercises the REAL server-side Paperclip path (session
 * sign-in with API-key fallback, then a companies list fetch) and reports
 * where it broke. Credential PRESENCE is reported as booleans only — never
 * values. Error text is truncated and only visible to admins.
 */

export const GET = withFault('admin/paperclip-health', async () => {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canAccessAdminRoute(user.role)) {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })
  }

  // The base URL is committed configuration (lib/paperclipConfig.ts), not a
  // secret — reporting it catches env-var drift between deploys at a glance.
  const config = {
    baseUrl: PAPERCLIP_BASE_URL,
    authEmailPresent: Boolean(process.env.PAPERCLIP_AUTH_EMAIL),
    authPasswordPresent: Boolean(process.env.PAPERCLIP_AUTH_PASSWORD),
    apiKeyPresent: Boolean(process.env.PAPERCLIP_API_KEY),
  }

  // Probe 1 — auth: which mode does the server actually resolve to right now?
  // (session sign-in first, API-key fallback — mirrors every real request)
  let auth:
    | { ok: true; mode: 'session-cookie' | 'api-key'; latencyMs: number }
    | { ok: false; errorClass: string; error: string; latencyMs: number }
  const authStart = Date.now()
  try {
    const headers = await getPaperclipAuthHeaders()
    auth = {
      ok: true,
      mode: 'Cookie' in headers ? 'session-cookie' : 'api-key',
      latencyMs: Date.now() - authStart,
    }
  } catch (err) {
    auth = {
      ok: false,
      errorClass: classifyPaperclipError(err),
      error: truncate(err),
      latencyMs: Date.now() - authStart,
    }
  }

  // Probe 2 — end-to-end data fetch (same call the feed/right panel makes).
  let companies:
    | { ok: true; count: number; latencyMs: number }
    | { ok: false; errorClass: string; error: string; latencyMs: number }
  const fetchStart = Date.now()
  try {
    const list = await getCompanies()
    companies = { ok: true, count: list.length, latencyMs: Date.now() - fetchStart }
  } catch (err) {
    companies = {
      ok: false,
      errorClass: classifyPaperclipError(err),
      error: truncate(err),
      latencyMs: Date.now() - fetchStart,
    }
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    healthy: auth.ok && companies.ok,
    config,
    auth,
    companies,
  })
})
