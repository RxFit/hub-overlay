import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
import { getAllRoleEntries, upsertUserRole, ensureSheetHeaders } from '@/lib/hubRoles'
import { canAssignRole } from '@/lib/roles'

export const runtime = 'nodejs'

/* ── GET /api/admin/roles ── */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  const callerRole = (session?.user as Record<string, unknown>)?.role as string

  if (!session?.user || !['admin', 'superadmin'].includes(callerRole)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const token = await getToken({ req })
  const accessToken = token?.accessToken as string | undefined
  if (!accessToken) {
    return NextResponse.json({ error: 'No access token' }, { status: 401 })
  }

  try {
    // Auto-initialize sheet headers on first access (idempotent)
    await ensureSheetHeaders(accessToken, process.env.HUB_ROLES_SHEET_ID).catch(() => {})
    const users = await getAllRoleEntries(accessToken, process.env.HUB_ROLES_SHEET_ID)
    return NextResponse.json({ users })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/* ── POST /api/admin/roles ── */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  const callerRole = (session?.user as Record<string, unknown>)?.role as string
  const callerEmail = session?.user?.email || ''

  if (!session?.user || !['admin', 'superadmin'].includes(callerRole)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const token = await getToken({ req })
  const accessToken = token?.accessToken as string | undefined
  if (!accessToken) {
    return NextResponse.json({ error: 'No access token' }, { status: 401 })
  }

  let body: { email: string; role: string; assignedProjects: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { email, role, assignedProjects } = body

  if (!email || !role) {
    return NextResponse.json({ error: 'email and role are required' }, { status: 400 })
  }

  // Validate role assignment permissions
  if (!canAssignRole(callerRole, role)) {
    return NextResponse.json(
      { error: `As ${callerRole}, you cannot assign the '${role}' role` },
      { status: 403 }
    )
  }

  // Prevent self-demotion for superadmins
  if (email.toLowerCase() === callerEmail.toLowerCase() && callerRole === 'superadmin') {
    return NextResponse.json(
      { error: 'Superadmins cannot change their own role via this panel' },
      { status: 400 }
    )
  }

  try {
    await upsertUserRole(
      { email, role, assignedProjects: assignedProjects || [], assignedBy: callerEmail },
      accessToken,
      process.env.HUB_ROLES_SHEET_ID
    )
    return NextResponse.json({ success: true, email, role })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
