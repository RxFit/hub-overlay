import { NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import type { NextRequest } from 'next/server'
import { listChatSpaces } from '@/lib/google'

export async function GET(req: NextRequest) {
  const token = await getToken({ req })
  if (!token?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const spaces = await listChatSpaces(token.accessToken as string)
    return NextResponse.json({ spaces })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[api/google/chat/spaces]', msg)

    if (msg.includes('403') || msg.includes('insufficientPermissions')) {
      return NextResponse.json(
        { error: 'Google Chat permission not granted. Please re-authenticate to allow Chat access.', code: 'MISSING_SCOPE' },
        { status: 403 }
      )
    }

    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
