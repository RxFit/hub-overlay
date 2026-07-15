import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { isGeminiConfigured } from '@/lib/gemini'
import { isClaudeConfigured } from '@/lib/claude'

export const runtime = 'nodejs'
// Never cache/prerender — the probe must reflect live provider + DB state on
// every request (Cloud Run startupProbe / deploy smoke test poll this).
export const dynamic = 'force-dynamic'

/**
 * GET /api/healthz — unauthenticated readiness/health probe (P0-2).
 *
 * Wired into two deploy gates so a broken revision fails to serve instead of
 * silently 500ing user traffic:
 *   - service.yaml startupProbe → HTTP GET /api/healthz (a booting app with no
 *     AI key or an unreachable DB now FAILS startup rather than taking traffic).
 *   - .github/workflows/deploy.yml smoke test → asserts this returns 200.
 *
 * Contract:
 *   200 {status:'ok',        providers:{gemini,anthropic}, db:true}  — healthy
 *   503 {status:'unhealthy', providers:{gemini,anthropic}, db:<bool>} — degraded
 *
 * "Healthy" = the DB answers a `SELECT 1` AND at least ONE AI provider key is
 * present. #79 added cross-provider Gemini↔Claude fallback, so the app is
 * functional with EITHER provider configured — 503 only when BOTH are missing
 * (or the DB is down). Per-provider booleans are always included so an operator
 * / the smoke test can see WHICH provider is unconfigured.
 *
 * SECURITY: the body exposes only booleans + a status string. It NEVER returns
 * key values/lengths/prefixes, DB credentials, or internal hostnames. This
 * route MUST stay in the middleware matcher's exclusion list (see
 * hub/middleware.ts) so the probe is reachable unauthenticated (no 401/redirect).
 */

// Bound the DB check so a genuinely hung/unreachable DB fails the probe fast
// (503, never a hang) rather than blocking the startupProbe until its own
// timeout. Widened 2.5s → 5s: a cold instance's FIRST-ever Cloud SQL socket
// connect routinely took >2.5s, so the probe false-reported db:false against a
// revision whose DB is fine once warm — the exact race that blocked deploys for
// days (2026-07-11/12). 5s absorbs the cold connect while still failing fast on
// a real outage. (The .run.app smoke test curls with --max-time 30, and
// service.yaml's startupProbe timeoutSeconds sits above this bound.)
const DB_TIMEOUT_MS = 5000

/** Cheap `SELECT 1` with a hard timeout. Never throws — returns false on any error/timeout. */
async function isDbHealthy(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('db healthcheck timeout')), DB_TIMEOUT_MS)
    })
    await Promise.race([db.execute(sql`SELECT 1`), timeout])
    return true
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function GET() {
  // Presence-only probes (booleans, never key material) — same non-throwing
  // probes the /admin/ai-health badges use (#79).
  const gemini = isGeminiConfigured()
  const anthropic = isClaudeConfigured()
  const dbHealthy = await isDbHealthy()

  // Cross-provider fallback (#79) means EITHER provider is enough to serve AI.
  const providersHealthy = gemini || anthropic
  const healthy = providersHealthy && dbHealthy

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'unhealthy',
      providers: { gemini, anthropic },
      db: dbHealthy,
    },
    { status: healthy ? 200 : 503 },
  )
}
