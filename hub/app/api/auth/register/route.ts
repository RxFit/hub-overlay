import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
import { getAllRoleEntries, upsertUserRole } from '@/lib/userRoles'

export const runtime = 'nodejs'

/**
 * POST /api/auth/register
 *
 * Called client-side after a new user lands in the onboarding state.
 * Writes an 'onboarding' row to the Hub Roles sheet using the ADMIN's
 * session token (pulled server-side via getToken) rather than the new
 * user's own token — which won't have write access to the shared sheet.
 *
 * This endpoint is intentionally open to any authenticated session.
 * It only ever writes role='onboarding' for the calling user's email.
 * Admins can then see and promote the user via /settings or /admin.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = await getToken({ req })
  const accessToken = token?.accessToken as string | undefined
  if (!accessToken) {
    return NextResponse.json({ error: 'No access token in session' }, { status: 401 })
  }

  const email = session.user.email.toLowerCase().trim()
  const sheetId = process.env.HUB_ROLES_SHEET_ID

  if (!sheetId) {
    // Sheet not configured — silently succeed so the client isn't blocked
    return NextResponse.json({ registered: false, reason: 'sheet_not_configured' })
  }

  try {
    // Check if already registered — don't overwrite an existing row
    const existing = await getAllRoleEntries(accessToken, sheetId)
    const alreadyExists = existing.some(e => e.email === email)

    if (alreadyExists) {
      return NextResponse.json({ registered: false, reason: 'already_exists' })
    }

    // Write the onboarding row using the calling user's own token.
    // This requires the Hub Roles sheet to be shared with the org domain at
    // "Editor" level (or at minimum this user's account).
    // If that fails, the error is returned so the client can surface it.
    await upsertUserRole(
      { email, role: 'onboarding', assignedProjects: [], assignedBy: 'self' },
      accessToken,
      sheetId
    )

    console.log(`[register] Self-registered onboarding user: ${email}`)
    return NextResponse.json({ registered: true, email })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.warn(`[register] Self-registration failed for ${email}:`, message)
    // Return 200 so the client isn't hard-blocked — the user still has onboarding role
    return NextResponse.json({ registered: false, reason: 'write_failed', detail: message })
  }
}
