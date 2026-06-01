import { NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import type { NextRequest } from 'next/server'
import { listChatMessages, sendChatMessage } from '@/lib/google'

export async function GET(req: NextRequest) {
  const token = await getToken({ req })
  if (!token?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const spaceId = searchParams.get('spaceId')
  const pageSize = parseInt(searchParams.get('pageSize') ?? '50', 10)

  if (!spaceId) {
    return NextResponse.json({ error: 'Missing spaceId' }, { status: 400 })
  }

  try {
    const messages = await listChatMessages(token.accessToken as string, spaceId, pageSize)
    return NextResponse.json({ messages })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[api/google/chat/messages GET]', msg)

    if (msg.includes('403') || msg.includes('insufficientPermissions')) {
      return NextResponse.json(
        { error: 'Google Chat permission not granted.', code: 'MISSING_SCOPE' },
        { status: 403 }
      )
    }

    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req })
  if (!token?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { spaceId, text, threadKey } = body

    if (!spaceId || !text?.trim()) {
      return NextResponse.json({ error: 'Missing spaceId or text' }, { status: 400 })
    }

    const message = await sendChatMessage(
      token.accessToken as string,
      spaceId,
      text.trim(),
      threadKey
    )

    return NextResponse.json({ message })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[api/google/chat/messages POST]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
