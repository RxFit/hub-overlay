import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleWriteErrorResponse, googleRouteCtx } from '@/lib/google-session'
import { searchContacts } from '@/lib/google'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/**
 * GET /api/google/contacts?q=<name> — resolve a name to contact email matches.
 * Read-only (contacts.readonly). Powers recipient resolution so the assistant
 * can turn "email Maria" into a real address. A grant predating the scope
 * surfaces as MISSING_SCOPE for a one-time re-consent.
 */
export const GET = withFault('google/contacts', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  const q = (new URL(req.url).searchParams.get('q') || '').trim()
  if (!q) {
    return NextResponse.json({ error: 'q (query) is required' }, { status: 400 })
  }

  try {
    const matches = await searchContacts(auth.accessToken, q)
    return NextResponse.json({ matches })
  } catch (err) {
    return googleWriteErrorResponse(err, 'Google Contacts', googleRouteCtx(req, '/api/google/contacts'))
  }
})
