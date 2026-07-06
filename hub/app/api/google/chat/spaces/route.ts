import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import { listChatSpaces } from '@/lib/google'

export async function GET(req: NextRequest) {
  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  try {
    const spaces = await listChatSpaces(auth.accessToken)
    return NextResponse.json({ spaces })
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

    return googleApiErrorResponse(err)
  }
}
