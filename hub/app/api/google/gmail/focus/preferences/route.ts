import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { normalizeFocusPreferences } from '@/lib/focus-preferences'
import { getFocusPreferences, upsertFocusPreferences } from '@/lib/focus-preferences-db'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/* ══════════════════════════════════════════════════════════════════════════════
   GMAIL FOCUS PREFERENCES
   GET  /api/google/gmail/focus/preferences  → this user's { vips, goals }
   PUT  /api/google/gmail/focus/preferences  ← { vips, goals } (validated)

   Personal-productivity config (the user's OWN VIP list + goals), so it's
   AUTH-ONLY — every signed-in user, onboarding guests included, may manage
   their own. Input is hardened by normalizeFocusPreferences before it touches
   the DB or the ranker.
   ══════════════════════════════════════════════════════════════════════════════ */

export const GET = withFault('google/gmail/focus/preferences', async (_req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // getFocusPreferences is fail-open — a DB outage returns empty prefs, never an error.
  const prefs = await getFocusPreferences(session.user.email)
  return NextResponse.json(prefs)
})

export const PUT = withFault('google/gmail/focus/preferences', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Normalize BEFORE persisting (dedupe, clamp, drop malformed entries). The
  // upsert re-normalizes too, but doing it here lets us return exactly what
  // was stored so the client reflects the cleaned list immediately.
  const clean = normalizeFocusPreferences(body)
  try {
    const saved = await upsertFocusPreferences(session.user.email, clean)
    return NextResponse.json(saved)
  } catch (err) {
    // Unlike the read path, a write failure is surfaced — a silent "saved" that
    // didn't persist is worse than an honest error.
    console.error('[focus/preferences] save failed:', err)
    return NextResponse.json({ error: 'Could not save preferences — please try again.' }, { status: 502 })
  }
})
