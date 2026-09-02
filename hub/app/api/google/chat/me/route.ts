import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth } from '@/lib/google-session'
import { getChatSelfUserName } from '@/lib/google'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/**
 * GET /api/google/chat/me — the caller's own Chat user name ("users/<id>").
 *
 * Chat message senders carry only an opaque user id, so "is this message
 * MINE?" — which gates the edit/delete affordances — needs the caller's People
 * id once per session. `{ name: null }` is a legitimate answer (People lookup
 * unavailable): the panel then simply never offers edit/delete.
 *
 * Instance-local cache: the id is immutable per account, so an hour-long
 * positive TTL is conservative; failures cache briefly so one People blip
 * doesn't hide the affordances for an hour.
 */
const cache = new Map<string, { name: string | null; exp: number }>()
const POSITIVE_TTL_MS = 60 * 60 * 1000
const NEGATIVE_TTL_MS = 5 * 60 * 1000

export const GET = withFault('google/chat/me', async (req: NextRequest) => {
  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  const session = await getServerSession(authOptions)
  const email = (session?.user?.email as string | undefined) ?? ''

  const hit = email ? cache.get(email) : undefined
  if (hit && hit.exp > Date.now()) {
    return NextResponse.json({ name: hit.name })
  }

  const name = await getChatSelfUserName(auth.accessToken)
  if (email) {
    cache.set(email, { name, exp: Date.now() + (name ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) })
  }
  return NextResponse.json({ name })
})
