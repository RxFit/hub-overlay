import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { resolveGoogleAuth, googleApiErrorResponse, googleRouteCtx } from '@/lib/google-session'
import { getSpaceReadState, countChatMessagesSince } from '@/lib/google'

export const runtime = 'nodejs'

/**
 * GET /api/google/chat/unread?spaceIds=spaces/A,spaces/B
 *
 * Batched unread-count endpoint (Plan 05 / Change 5). Collapses what used to be
 * a client-side `setInterval` fan-out (N readstate + N messages fetches per
 * tick, bypassing the client cache) into a single request. For each requested space it
 * compares the user's `lastReadTime` against the latest messages and returns:
 *
 *   { unread: Record<spaceId, number>, total: number }
 *
 * Per-space failures degrade silently (count 0) so one bad space never blanks
 * the badge. Concurrency is throttled to stay under Google API rate limits.
 */
export async function GET(req: NextRequest) {
  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  const accessToken = auth.accessToken
  const raw = req.nextUrl.searchParams.get('spaceIds') ?? ''
  const spaceIds = raw.split(',').map(s => s.trim()).filter(Boolean)

  if (spaceIds.length === 0) {
    return NextResponse.json({ unread: {}, total: 0 })
  }

  const unread: Record<string, number> = {}
  let total = 0
  const MAX_CONCURRENT = 5

  try {
    for (let i = 0; i < spaceIds.length; i += MAX_CONCURRENT) {
      const batch = spaceIds.slice(i, i + MAX_CONCURRENT)
      await Promise.all(
        batch.map(async (spaceId) => {
          try {
            const readState = await getSpaceReadState(accessToken, spaceId)
            if (!readState.lastReadTime) return

            // Server-side `createTime >` filter + field mask: Google returns
            // only the names of unread messages, not 50 full bodies per space
            // per poll. Count semantics unchanged (capped at 50).
            const count = await countChatMessagesSince(accessToken, spaceId, readState.lastReadTime, 50)

            unread[spaceId] = count
            total += count
          } catch {
            // Individual space failure (e.g. missing read-state scope) — skip.
          }
        })
      )
    }

    return NextResponse.json({ unread, total })
  } catch (err) {
    return googleApiErrorResponse(err, googleRouteCtx(req, '/api/google/chat/unread'))
  }
}
