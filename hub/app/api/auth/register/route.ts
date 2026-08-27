import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { recordEvent } from '@/lib/event-logger'
import { withFault } from '@/lib/route-fault'
import { getAllRoleEntries, upsertUserRole } from '@/lib/userRoles'

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
// withFault, and NO swallowing catch (spec Layer 9 #1): a failed hub_users
// write used to answer 200 { registered: false, reason: 'write_failed' } —
// invisible to everything. The caller (OnboardingCard) is fire-and-forget and
// never reads the body, so the honest 500 blocks nothing; the failure now
// gets logged and reported. `already_exists` is a legitimate success outcome,
// keyed `outcome` (not `reason`) so a 2xx body never carries a failure-shaped
// key.
export const POST = withFault('auth/register', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const email = session.user.email.toLowerCase().trim()

  // Check if already registered — don't overwrite an existing row
  const existing = await getAllRoleEntries()
  const alreadyExists = existing.some(e => e.email === email)

  if (alreadyExists) {
    return NextResponse.json({ registered: false, outcome: 'already_exists' })
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
})
