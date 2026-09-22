import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessAdminRoute } from '@/lib/roles'
import { withFault } from '@/lib/route-fault'
import { getTenantId } from '@/lib/tenant-context'
import { embedForVault } from '@/lib/vault/embeddings'
import { checkVaultSearchHealth } from '@/lib/vault/health'
import { createDrizzleVaultStore } from '@/lib/vault/store'

export const runtime = 'nodejs'

/**
 * GET /api/admin/vault-search-health — is the AntigravityHQ vault search
 * ready, and if not, which stage is missing?
 *
 * Admin/superadmin ONLY, enforced here (the middleware guards /admin PAGES,
 * not /api/admin/*) — mirrors /api/admin/semantic-brain-health. Reports
 * whether VAULT_GITHUB_TOKEN is bound, whether scope is configured, the last
 * sync run, coverage counts and embedding reachability (one bounded live
 * call; `?probe=0` skips it). 200 when healthy, 503 otherwise, same body.
 * The optional Lane 2 endpoint (Smart Connections) is reported in its own
 * `smartConnections` section — probed only when configured, and never part of
 * the healthy/readiness computation (`?probe=0` skips that probe too).
 * Presence booleans and counts only — never a token, key or note content.
 */
export const GET = withFault('admin/vault-search-health', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canAccessAdminRoute(user.role)) {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })
  }

  const probe = req.nextUrl.searchParams.get('probe') !== '0'
  const report = await checkVaultSearchHealth({
    store: createDrizzleVaultStore(),
    embed: embedForVault,
    tenantId: getTenantId(),
    probeEmbedding: probe,
  })

  return NextResponse.json(report, { status: report.healthy ? 200 : 503 })
})
