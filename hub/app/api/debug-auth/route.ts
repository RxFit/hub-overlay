import { NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import type { NextRequest } from 'next/server'

export const runtime = 'nodejs'

// Temporary diagnostic endpoint — shows the exact email + role in the JWT.
// DELETE THIS FILE after diagnosing the superadmin issue.
export async function GET(req: NextRequest) {
  const token = await getToken({ req })
  if (!token) {
    return NextResponse.json({ error: 'No token — not signed in' }, { status: 401 })
  }

  const superadminEmails = (process.env.SUPERADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)

  return NextResponse.json({
    email: token.email,
    emailNormalized: (token.email as string || '').toLowerCase(),
    role: token.role,
    superadminEmails,
    isMatch: superadminEmails.includes((token.email as string || '').toLowerCase()),
    assignedProjects: token.assignedProjects,
    sub: token.sub,
  })
}
