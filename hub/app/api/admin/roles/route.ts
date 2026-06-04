import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
import { getAllRoleEntries, upsertUserRole, ensureSheetHeaders } from '@/lib/userRoles'
import { canAssignRole } from '@/lib/roles'

export const runtime = 'nodejs'

/* Role hierarchy — higher index = more privilege */
const ROLE_RANK: Record<string, number> = {
  onboarding: 0,
  staff: 1,
  admin: 2,
  superadmin: 3,
}

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

  const { email: rawEmail, role, assignedProjects } = body
  const email = (rawEmail || '').trim().toLowerCase()

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'Valid email is required' }, { status: 400 })
  }

  const VALID_ROLES = ['superadmin', 'admin', 'staff', 'onboarding'] as const
  if (!role || !VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
    return NextResponse.json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` }, { status: 400 })
  }

  // Validate role assignment permissions
  if (!canAssignRole(callerRole, role)) {
    return NextResponse.json(
      { error: `As ${callerRole}, you cannot assign the '${role}' role` },
      { status: 403 }
    )
  }

  // Prevent self-demotion for ALL roles (not just superadmin)
  if (email === callerEmail.toLowerCase()) {
    return NextResponse.json(
      { error: 'You cannot change your own role via this panel' },
      { status: 400 }
    )
  }

  // Prevent downgrading a role to a lower privilege level
  // e.g. admin cannot set a superadmin to 'onboarding'
  try {
    const allEntries = await import('@/lib/userRoles').then(m => m.getAllRoleEntries('', process.env.HUB_ROLES_SHEET_ID))
    const existingEntry = allEntries.find(e => e.email === email)
    if (existingEntry) {
      const existingRank = ROLE_RANK[existingEntry.role] ?? 0
      const newRank = ROLE_RANK[role] ?? 0
      const callerRank = ROLE_RANK[callerRole] ?? 0
      if (existingRank >= callerRank) {
        return NextResponse.json(
          { error: `Cannot modify a user with equal or higher privilege (${existingEntry.role})` },
          { status: 403 }
        )
      }
      if (newRank > callerRank) {
        return NextResponse.json(
          { error: `Cannot promote a user above your own role (${callerRole})` },
          { status: 403 }
        )
      }
    }
  } catch {
    // DB lookup failure — proceed (the upsert will still respect canAssignRole)
  }

  try {
    // Log a warning if staff gets no project assignments (they'll see nothing useful)
    if (role === 'staff' && (!assignedProjects || assignedProjects.length === 0)) {
      console.warn(`[admin/roles] Staff user ${email} assigned with no projects — they will see an empty dashboard until projects are assigned`)
    }

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
