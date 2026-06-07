/**
 * API Route: /api/settings/keys
 *
 * Proxies CRUD operations to Paperclip's per-workspace encrypted Secrets API.
 * No secrets are stored in the HUB database — all persistence is in Paperclip.
 *
 * Security:
 *  - admin/superadmin: full CRUD for assigned workspaces
 *  - staff: read key names only (no values)
 *  - onboarding: blocked
 *  - Secret VALUES are never returned to the browser (write-only)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getPaperclipAuthHeaders, clearPaperclipSession } from '@/lib/paperclipSession'

export const runtime = 'nodejs'

const PAPERCLIP_BASE = process.env.PAPERCLIP_BASE_URL ?? ''
const DEFAULT_COMPANY_ID = process.env.DEFAULT_PAPERCLIP_COMPANY_ID ?? ''

/** Resolve which Paperclip workspace (company) to operate on */
function resolveCompanyId(session: Record<string, unknown>, requestedId?: string): string {
  const user = session.user as Record<string, unknown> | undefined
  const projects = (user?.assignedProjects as string[]) ?? []
  const role = (user?.role as string) ?? ''

  // Superadmin can target any workspace
  if (role === 'superadmin') {
    return requestedId || DEFAULT_COMPANY_ID
  }

  // Admin/staff can only target their assigned projects
  if (requestedId && projects.includes('*')) {
    return requestedId
  }
  if (requestedId && projects.includes(requestedId)) {
    return requestedId
  }

  // Fallback: first assigned project, or default
  if (projects.length > 0 && projects[0] !== '*') {
    return projects[0]
  }
  if (projects.includes('*')) {
    return requestedId || DEFAULT_COMPANY_ID
  }

  return DEFAULT_COMPANY_ID
}

/**
 * GET /api/settings/keys?companyId=xxx
 * Lists all secrets for a workspace. Returns names + metadata only (no values).
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const role = (session.user as Record<string, unknown>)?.role as string
  if (role === 'onboarding') {
    return NextResponse.json({ error: 'Complete onboarding first' }, { status: 403 })
  }

  try {
    const { searchParams } = req.nextUrl
    const requestedCompanyId = searchParams.get('companyId') ?? undefined
    const companyId = resolveCompanyId(session as unknown as Record<string, unknown>, requestedCompanyId)

    if (!companyId) {
      return NextResponse.json({ error: 'No workspace assigned' }, { status: 400 })
    }

    const authHeaders = await getPaperclipAuthHeaders()
    const res = await fetch(`${PAPERCLIP_BASE}/api/companies/${companyId}/secrets`, {
      headers: {
        ...authHeaders,
        Origin: PAPERCLIP_BASE,
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (res.status === 401 || res.status === 403) {
      clearPaperclipSession()
      return NextResponse.json({ error: 'Paperclip auth failed' }, { status: 502 })
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return NextResponse.json({ error: `Paperclip error: ${body}` }, { status: res.status })
    }

    const secrets = await res.json()

    // Strip values — return only metadata
    const safe = (Array.isArray(secrets) ? secrets : []).map((s: Record<string, unknown>) => ({
      id: s.id,
      name: s.name,
      key: s.key,
      provider: s.provider,
      status: s.status,
      latestVersion: s.latestVersion,
      lastRotatedAt: s.lastRotatedAt,
      createdAt: s.createdAt,
      // Mask: show last 4 chars if staff+ (never full value)
      maskedHint: typeof s.name === 'string' ? '••••' : null,
    }))

    return NextResponse.json({ secrets: safe, companyId })
  } catch (err) {
    console.error('[settings/keys GET]', err)
    return NextResponse.json({ error: 'Failed to load keys' }, { status: 500 })
  }
}

/**
 * POST /api/settings/keys
 * Creates a new secret in the user's workspace.
 * Body: { name: string, value: string, companyId?: string }
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const role = (session.user as Record<string, unknown>)?.role as string
  if (role !== 'admin' && role !== 'superadmin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  try {
    const body = await req.json()
    const { name, value, companyId: requestedCompanyId } = body

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    if (!value || typeof value !== 'string') {
      return NextResponse.json({ error: 'value is required' }, { status: 400 })
    }

    // Validate key name format
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      return NextResponse.json({
        error: 'Key name must be uppercase with underscores (e.g. MY_API_KEY)',
      }, { status: 400 })
    }

    // Block dangerous keys
    const BLOCKED_KEYS = ['RAILWAY_TOKEN', 'VERCEL_TOKEN', 'NEXTAUTH_SECRET', 'PAPERCLIP_MASTER_KEY']
    if (BLOCKED_KEYS.includes(name)) {
      return NextResponse.json({ error: `${name} cannot be managed through this interface` }, { status: 403 })
    }

    const companyId = resolveCompanyId(session as unknown as Record<string, unknown>, requestedCompanyId)
    if (!companyId) {
      return NextResponse.json({ error: 'No workspace assigned' }, { status: 400 })
    }

    const authHeaders = await getPaperclipAuthHeaders()
    const res = await fetch(`${PAPERCLIP_BASE}/api/companies/${companyId}/secrets`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        Origin: PAPERCLIP_BASE,
      },
      body: JSON.stringify({ name, value }),
      signal: AbortSignal.timeout(10_000),
    })

    if (res.status === 401 || res.status === 403) {
      clearPaperclipSession()
      return NextResponse.json({ error: 'Paperclip auth failed' }, { status: 502 })
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      return NextResponse.json({ error: `Failed to save key: ${errBody}` }, { status: res.status })
    }

    const created = await res.json()
    return NextResponse.json({
      created: true,
      id: created.id,
      name: created.name,
      provider: created.provider,
    })
  } catch (err) {
    console.error('[settings/keys POST]', err)
    return NextResponse.json({ error: 'Failed to save key' }, { status: 500 })
  }
}

/**
 * DELETE /api/settings/keys?id=xxx
 * Deletes a secret by ID.
 */
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const role = (session.user as Record<string, unknown>)?.role as string
  if (role !== 'admin' && role !== 'superadmin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  try {
    const { searchParams } = req.nextUrl
    const secretId = searchParams.get('id')
    if (!secretId) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    const requestedCompanyId = searchParams.get('companyId') ?? undefined
    const companyId = resolveCompanyId(session as unknown as Record<string, unknown>, requestedCompanyId)
    if (!companyId) {
      return NextResponse.json({ error: 'No workspace assigned' }, { status: 400 })
    }

    const authHeaders = await getPaperclipAuthHeaders()

    // Retrieve company secrets first to verify ownership of secretId
    const verifyRes = await fetch(`${PAPERCLIP_BASE}/api/companies/${companyId}/secrets`, {
      headers: {
        ...authHeaders,
        Origin: PAPERCLIP_BASE,
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (verifyRes.status === 401 || verifyRes.status === 403) {
      clearPaperclipSession()
      return NextResponse.json({ error: 'Paperclip auth failed' }, { status: 502 })
    }

    if (!verifyRes.ok) {
      const verifyErrBody = await verifyRes.text().catch(() => '')
      return NextResponse.json({ error: `Failed to verify key ownership: ${verifyErrBody}` }, { status: verifyRes.status })
    }

    const companySecrets = await verifyRes.json()
    const secretExists = (Array.isArray(companySecrets) ? companySecrets : []).some(
      (s: Record<string, unknown>) => s.id === secretId
    )

    if (!secretExists) {
      return NextResponse.json({ error: 'Access denied: secret does not belong to your workspace' }, { status: 403 })
    }

    const res = await fetch(`${PAPERCLIP_BASE}/api/secrets/${secretId}`, {
      method: 'DELETE',
      headers: {
        ...authHeaders,
        Origin: PAPERCLIP_BASE,
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (res.status === 401 || res.status === 403) {
      clearPaperclipSession()
      return NextResponse.json({ error: 'Paperclip auth failed' }, { status: 502 })
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      return NextResponse.json({ error: `Failed to delete key: ${errBody}` }, { status: res.status })
    }

    return NextResponse.json({ deleted: true })
  } catch (err) {
    console.error('[settings/keys DELETE]', err)
    return NextResponse.json({ error: 'Failed to delete key' }, { status: 500 })
  }
}
