import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { normalizeChatSpacePreferences } from '@/lib/chat-spaces'
import {
  getChatSpacePreferences,
  upsertChatSpacePreferences,
} from '@/lib/chat-space-preferences-db'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/* ══════════════════════════════════════════════════════════════════════════════
   GOOGLE CHAT SPACE VISIBILITY PREFERENCES
   GET  /api/google/chat/spaces/preferences  → this user's { shown, hidden }
   PUT  /api/google/chat/spaces/preferences  ← { shown, hidden } (validated)

   Which spaces a user wants in their own Chat panel is personal UI config, so
   this is AUTH-ONLY — every signed-in user, onboarding guests included, may
   manage their own. The stored value is a set of OVERRIDES on the default rule
   in lib/chat-spaces.ts, not a snapshot of space names; input is hardened by
   normalizeChatSpacePreferences before it touches the DB.

   This lives in Postgres rather than localStorage so the choice survives
   sign-out, a new browser, a new device and a redeploy — the whole point of the
   change.
   ══════════════════════════════════════════════════════════════════════════════ */

export const GET = withFault('google/chat/spaces/preferences', async (_req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // getChatSpacePreferences is fail-open — a DB outage returns empty
  // preferences (i.e. plain defaults), never an error.
  const prefs = await getChatSpacePreferences(session.user.email)
  return NextResponse.json(prefs)
})

export const PUT = withFault('google/chat/spaces/preferences', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Normalize BEFORE persisting (dedupe, drop malformed names, resolve
  // shown/hidden conflicts). The upsert re-normalizes too, but doing it here
  // lets us return exactly what was stored so the client reflects the cleaned
  // result immediately.
  const clean = normalizeChatSpacePreferences(body)
  try {
    const saved = await upsertChatSpacePreferences(session.user.email, clean)
    return NextResponse.json(saved)
  } catch (err) {
    // Unlike the read path, a write failure is surfaced — a silent "saved" that
    // didn't persist is precisely the bug this feature exists to fix.
    console.error('[chat/spaces/preferences] save failed:', err)
    return NextResponse.json(
      { error: 'Could not save your space choices — please try again.' },
      { status: 502 },
    )
  }
})
