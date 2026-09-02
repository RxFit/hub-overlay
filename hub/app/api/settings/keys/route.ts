/**
 * API Route: /api/settings/keys
 *
 * Hub-owned storage for operator-managed third-party credentials.
 *
 * Until Phase 3 PR 1 this proxied Paperclip's per-workspace Secrets API and
 * stored nothing locally. Paperclip is retired (AGENTS.md), so persistence
 * moved into the Hub's own encrypted `hub_secrets` table. The externally
 * visible contract is unchanged — same verbs, same response shapes — so the
 * settings UI needed no migration.
 *
 * Security (carried over verbatim):
 *  - admin/superadmin: full CRUD for assigned workspaces
 *  - staff: read key names only (no values)
 *  - onboarding: blocked
 *  - Secret VALUES are never returned to the browser (write-only)
 *
 * The value-bearing paths live in lib/secrets-store.ts — a route.ts may
 * export only HTTP handlers, so anything testable has to live elsewhere.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import {
  listSecrets,
  putSecret,
  deleteSecret,
  resolveWorkspaceId,
  storageConfigured,
  type SessionLike,
} from '@/lib/secrets-store'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

function sessionUser(session: unknown): SessionLike & { email?: string } {
  const user = (session as { user?: Record<string, unknown> } | null)?.user ?? {}
  return {
    role: (user.role as string) ?? '',
    assignedProjects: (user.assignedProjects as string[]) ?? [],
    email: (user.email as string) ?? undefined,
  }
}

/**
 * GET /api/settings/keys?companyId=xxx
 * Lists a workspace's credentials. Names + metadata only — never values.
 */
export const GET = withFault('settings/keys', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = sessionUser(session)
  if (user.role === 'onboarding') {
    return NextResponse.json({ error: 'Complete onboarding first' }, { status: 403 })
  }

  const requested = req.nextUrl.searchParams.get('companyId') ?? undefined
  const companyId = resolveWorkspaceId(user, requested)
  if (!companyId) {
    return NextResponse.json({ error: 'No workspace assigned' }, { status: 400 })
  }

  const secrets = await listSecrets(companyId)
  // `configured: false` distinguishes "no keys yet" from "this deployment
  // cannot store keys at all". Without it an unconfigured Hub looks like an
  // empty workspace right up until the operator's first save 503s.
  return NextResponse.json({ secrets, companyId, configured: storageConfigured() })
})

/**
 * POST /api/settings/keys
 * Stores a credential. Body: { name, value, companyId?, provider? }
 * Re-posting an existing name rotates it in place.
 */
export const POST = withFault('settings/keys', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = sessionUser(session)
  if (user.role !== 'admin' && user.role !== 'superadmin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await req.json()
  const { name, value, companyId: requested, provider } = body ?? {}

  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (!value || typeof value !== 'string') {
    return NextResponse.json({ error: 'value is required' }, { status: 400 })
  }

  const companyId = resolveWorkspaceId(user, requested)
  if (!companyId) {
    return NextResponse.json({ error: 'No workspace assigned' }, { status: 400 })
  }

  const result = await putSecret({
    companyId,
    name,
    value,
    provider: typeof provider === 'string' ? provider : null,
    createdBy: user.email ?? null,
  })

  if (!result.ok) {
    switch (result.reason) {
      case 'invalid_name':
        return NextResponse.json(
          { error: 'Key name must be uppercase with underscores (e.g. MY_API_KEY)' },
          { status: 400 },
        )
      case 'blocked':
        return NextResponse.json(
          { error: `${name} cannot be managed through this interface` },
          { status: 403 },
        )
      case 'not_configured':
        // Fail closed and say so plainly. Storing the value unencrypted
        // would be undetectable: nothing ever reads it back.
        return NextResponse.json(
          {
            error:
              'Credential storage is not configured on this deployment (SECRET_ENCRYPTION_KEY is unset). Refusing to store the key unencrypted.',
          },
          { status: 503 },
        )
      default:
        return NextResponse.json({ error: 'Failed to save key' }, { status: 409 })
    }
  }

  return NextResponse.json({
    created: true,
    id: result.secret.id,
    name: result.secret.name,
    provider: result.secret.provider,
  })
})

/**
 * DELETE /api/settings/keys?id=xxx
 * Removes a credential. The delete is workspace-scoped in the statement
 * itself, so an id from another workspace simply matches nothing.
 */
export const DELETE = withFault('settings/keys', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = sessionUser(session)
  if (user.role !== 'admin' && user.role !== 'superadmin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const secretId = req.nextUrl.searchParams.get('id')
  if (!secretId) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const requested = req.nextUrl.searchParams.get('companyId') ?? undefined
  const companyId = resolveWorkspaceId(user, requested)
  if (!companyId) {
    return NextResponse.json({ error: 'No workspace assigned' }, { status: 400 })
  }

  const removed = await deleteSecret(secretId, companyId)
  if (!removed) {
    // Same response whether the id is unknown or belongs to another
    // workspace — ids stay non-enumerable.
    return NextResponse.json(
      { error: 'Access denied: secret does not belong to your workspace' },
      { status: 403 },
    )
  }

  return NextResponse.json({ deleted: true })
})
