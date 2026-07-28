import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getEffectivePrefs, savePrefs } from '@/lib/google/prefs-db'
import { normalizePrefsInput } from '@/lib/google/prefs'
import { recordEvent } from '@/lib/event-logger'

export const runtime = 'nodejs'

/**
 * GET / PUT /api/settings/google-prefs — the tenant's analytics configuration
 * (which GA4 property and Search Console site its numbers come from).
 *
 * Admin-gated on both verbs: this is a tenant-level setting, and one user
 * repointing it changes what every other user's dashboard reports.
 *
 * GET returns the EFFECTIVE values (stored, else the legacy env-var fallback),
 * so the settings UI shows what the app is actually using rather than an empty
 * form on a deployment that has always run on env vars.
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  const role = (session?.user as Record<string, unknown>)?.role as string

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!['admin', 'superadmin'].includes(role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    return NextResponse.json({ prefs: await getEffectivePrefs() })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions)
  const role = (session?.user as Record<string, unknown>)?.role as string
  const email = session?.user?.email ?? ''

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!['admin', 'superadmin'].includes(role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    // Writes throw on failure so a save that did not persist is reported as
    // one, rather than returning a reassuring 200.
    const saved = await savePrefs(normalizePrefsInput(body), email)
    await recordEvent({
      eventType: 'google_prefs_updated',
      actor: email,
      resourceType: 'google_prefs',
      payload: { ga4PropertyId: saved.ga4PropertyId, gscSiteUrl: saved.gscSiteUrl },
    }).catch(() => {})
    return NextResponse.json({ prefs: saved })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
