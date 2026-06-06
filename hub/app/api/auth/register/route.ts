import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getAllRoleEntries, upsertUserRole } from '@/lib/userRoles'
import { recordEvent } from '@/lib/event-logger'

export const runtime = 'nodejs'

/**
 * POST /api/auth/register
 *
 * Called client-side after a new user lands in the onboarding state.
 * Writes an 'onboarding' row to the hub_users table in the database.
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

  const email = session.user.email.toLowerCase().trim()

  try {
    // Check if already registered — don't overwrite an existing row
    const existing = await getAllRoleEntries()
    const alreadyExists = existing.some(e => e.email === email)

    if (alreadyExists) {
      return NextResponse.json({ registered: false, reason: 'already_exists' })
    }

    // Write the onboarding row directly to the Postgres database.
    await upsertUserRole({
      email,
      role: 'onboarding',
      assignedProjects: [],
      assignedBy: 'self',
    })

    await recordEvent({
      eventType: 'auth.registered',
      actor: `hub-user:${email}`,
      resourceType: 'user',
      resourceId: email,
      payload: {
        role: 'onboarding',
      },
    })

    console.log(`[register] Self-registered onboarding user: ${email}`)
    return NextResponse.json({ registered: true, email })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.warn(`[register] Self-registration failed for ${email}:`, message)
    // Return 200 so the client isn't hard-blocked — the user still has onboarding role
    return NextResponse.json({ registered: false, reason: 'write_failed', detail: message })
  }
}
