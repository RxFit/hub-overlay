import { NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import type { NextRequest } from 'next/server'
import { listChatMessages, sendChatMessage } from '@/lib/google'
import { GoogleChatSendSchema } from '@/lib/zod-schemas'
import { requireAiGate } from '@/lib/requireGate'

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

  // P0-2 (Option B): AI-originated posts (X-AI-Intent present) must carry a
  // valid server-issued quality-gate token — missing/forged/expired/mismatched
  // tokens fail closed. Manual composer posts carry no AI marker and pass.
  const gate = requireAiGate(req.headers, ['post_chat_message'])
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  try {
    const raw = await req.json()
    const parsed = GoogleChatSendSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 }
      )
    }
    const { spaceId, text, threadKey } = parsed.data

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
