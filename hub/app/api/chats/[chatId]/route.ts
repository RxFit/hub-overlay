import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getChatMessages } from '@/lib/chat-store'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/chats/:chatId — a persisted conversation's messages in order
 * (Phase 2 conversation persistence). 404 for both "doesn't exist" and
 * "belongs to someone else" — indistinguishable by design, so client-minted
 * ids can't be probed for existence.
 */
export const GET = withFault('chats/[chatId]', async (req: NextRequest, { params }: { params: { chatId: string } }) => {
  const session = await getServerSession(authOptions)
  const email = session?.user?.email
  if (!email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { chatId } = params
  if (!/^[A-Za-z0-9-]{8,64}$/.test(chatId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const messages = await getChatMessages(chatId, email)
  if (messages === null) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json({ chatId, messages })
})
