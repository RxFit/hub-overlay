import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse, googleRouteCtx } from '@/lib/google-session'
import { listChatSpaces, hydrateBotDmDisplayNames } from '@/lib/google'
import { classifyChatSpace, isDefaultVisibleSpace, EMPTY_CHAT_SPACE_PREFERENCES } from '@/lib/chat-spaces'
import { getChatSpacePreferences } from '@/lib/chat-space-preferences-db'
import { withFault } from '@/lib/route-fault'

/**
 * GET /api/google/chat/spaces
 *
 * Returns EVERY space the user belongs to, each annotated with its classified
 * `kind` and whether the default rule shows it, PLUS the user's saved
 * visibility overrides — in one round trip.
 *
 * Shipping the preferences alongside the spaces (instead of leaving the client
 * to fetch them separately) is deliberate: the panel can compute the visible
 * set on first paint, so the user never sees a flash of every Meet chat before
 * their preferences load.
 */
export const GET = withFault('google/chat/spaces', async (req: NextRequest) => {
  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  try {
    const [spaces, preferences] = await Promise.all([
      // Bot/app DMs come through since lib/google.ts stopped dropping them, but
      // a DM space has no displayName of its own — hydrate it from the app's
      // membership so "Hermes" reads as Hermes, not as a bare space id.
      listChatSpaces(auth.accessToken).then(s => hydrateBotDmDisplayNames(auth.accessToken, s)),
      // Preferences are per-user; resolveGoogleAuth only proves a Google token,
      // so read the session for the email. Fail-open to defaults if absent.
      (async () => {
        const session = await getServerSession(authOptions)
        const email = session?.user?.email
        return email ? getChatSpacePreferences(email) : EMPTY_CHAT_SPACE_PREFERENCES
      })(),
    ])

    const annotated = spaces.map(space => ({
      ...space,
      kind: classifyChatSpace(space),
      defaultVisible: isDefaultVisibleSpace(space),
    }))

    return NextResponse.json({ spaces: annotated, preferences })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[api/google/chat/spaces]', msg)

    // Missing Chat scope keeps its dedicated 403 + MISSING_SCOPE code — the
    // client's `missingScope` UX branches on it. Must run BEFORE the generic
    // mapper, which would fold 403 into a reauth 401.
    if (msg.includes('403') || msg.includes('insufficientPermissions')) {
      return NextResponse.json(
        { error: 'Google Chat permission not granted. Please re-authenticate to allow Chat access.', code: 'MISSING_SCOPE' },
        { status: 403 }
      )
    }

    return googleApiErrorResponse(err, googleRouteCtx(req, '/api/google/chat/spaces'))
  }
})
