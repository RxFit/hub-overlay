import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { listChats } from '@/lib/chat-store'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/chats')

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/chats — the caller's persisted conversations, most recent first
 * (Phase 2 conversation persistence; written by /api/chat when the client
 * sends a chatId). Strictly self-scoped: the session email is the only key —
 * there is no admin cross-user view here by design (conversations are product
 * data; an operator needing another user's history can ask the DB).
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  const email = session?.user?.email
  if (!email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rawLimit = Number(req.nextUrl.searchParams.get('limit'))
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50) : 20

  try {
    const chats = await listChats(email, limit)
    return NextResponse.json({ chats })
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to list chats')
    return NextResponse.json({ error: 'Failed to list chats' }, { status: 500 })
  }
}
