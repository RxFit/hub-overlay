import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'

export const runtime = 'nodejs'

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

async function gmailGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown')
    throw new Error(`Gmail API ${res.status}: ${text}`)
  }
  return res.json()
}

async function gmailPost<T>(path: string, accessToken: string, body: unknown): Promise<T> {
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown')
    throw new Error(`Gmail API ${res.status}: ${text}`)
  }
  return res.json()
}

/* ── GET /api/google/gmail ── */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const token = await getToken({ req })
  const accessToken = token?.accessToken as string | undefined
  if (!accessToken) return NextResponse.json({ error: 'No access token' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const view = searchParams.get('view') || 'inbox'
  const threadId = searchParams.get('threadId')
  const maxResults = parseInt(searchParams.get('maxResults') || '20', 10)

  try {
    // Return a specific thread
    if (threadId) {
      const thread = await gmailGet<GmailThread>(`/threads/${threadId}?format=full`, accessToken)
      return NextResponse.json({ thread: parseThread(thread) })
    }

    // Return inbox thread list
    const label = view === 'sent' ? 'SENT' : view === 'unread' ? 'UNREAD' : 'INBOX'
    const list = await gmailGet<{ threads?: { id: string; snippet: string }[]; resultSizeEstimate: number }>(
      `/threads?labelIds=${label}&maxResults=${maxResults}`,
      accessToken
    )

    if (!list.threads?.length) {
      return NextResponse.json({ threads: [], unreadCount: 0 })
    }

    // Fetch metadata for each thread in parallel
    const threads = await Promise.all(
      list.threads.map(t =>
        gmailGet<GmailThread>(`/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, accessToken)
          .then(parseThreadMeta)
          .catch(() => null)
      )
    )

    // Get unread count
    let unreadCount = 0
    try {
      const unread = await gmailGet<{ threads?: unknown[] }>(`/threads?labelIds=UNREAD&maxResults=1`, accessToken)
      // Gmail doesn't give total count cheaply — we get resultSizeEstimate elsewhere
      const labelInfo = await gmailGet<{ messagesUnread: number }>(`/labels/INBOX`, accessToken)
      unreadCount = labelInfo.messagesUnread ?? 0
    } catch {
      // non-fatal
    }

    return NextResponse.json({
      threads: threads.filter(Boolean),
      unreadCount,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/* ── POST /api/google/gmail — send or reply ── */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const token = await getToken({ req })
  const accessToken = token?.accessToken as string | undefined
  if (!accessToken) return NextResponse.json({ error: 'No access token' }, { status: 401 })

  const body = await req.json()
  const { to, subject, message, threadId, inReplyTo } = body

  if (!to || !message) {
    return NextResponse.json({ error: 'to and message are required' }, { status: 400 })
  }

  const from = session.user.email ?? ''
  const subjectLine = subject || (inReplyTo ? `Re: ${inReplyTo}` : '(no subject)')

  // Build RFC 2822 email
  const emailLines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subjectLine}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    'Content-Type: text/plain; charset=UTF-8',
    '',
    message,
  ]
  const raw = Buffer.from(emailLines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  try {
    const payload: Record<string, string> = { raw }
    if (threadId) payload.threadId = threadId

    const sent = await gmailPost<{ id: string; threadId: string }>('/messages/send', accessToken, payload)

    // Mark thread as read if replying
    if (threadId) {
      await gmailPost(`/threads/${threadId}/modify`, accessToken, {
        removeLabelIds: ['UNREAD'],
      }).catch(() => {})
    }

    return NextResponse.json({ sent: true, messageId: sent.id, threadId: sent.threadId })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/* ── Parsers ── */

interface GmailThread {
  id: string
  messages?: GmailMessage[]
  snippet?: string
}

interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  payload?: {
    headers?: { name: string; value: string }[]
    body?: { data?: string }
    parts?: { mimeType: string; body?: { data?: string } }[]
  }
  internalDate?: string
}

function getHeader(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function decodeBody(msg: GmailMessage): string {
  const data =
    msg.payload?.body?.data ||
    msg.payload?.parts?.find(p => p.mimeType === 'text/plain')?.body?.data ||
    ''
  if (!data) return msg.snippet ?? ''
  return Buffer.from(data, 'base64').toString('utf-8')
}

function parseThreadMeta(thread: GmailThread) {
  const lastMsg = thread.messages?.[thread.messages.length - 1]
  if (!lastMsg) return null
  const isUnread = lastMsg.labelIds?.includes('UNREAD') ?? false
  return {
    id: thread.id,
    subject: getHeader(lastMsg, 'Subject') || '(no subject)',
    from: getHeader(lastMsg, 'From') || '',
    date: getHeader(lastMsg, 'Date') || '',
    snippet: thread.messages?.[0]?.snippet ?? '',
    isUnread,
    messageCount: thread.messages?.length ?? 1,
  }
}

function parseThread(thread: GmailThread) {
  return {
    id: thread.id,
    messages: (thread.messages ?? []).map(msg => ({
      id: msg.id,
      from: getHeader(msg, 'From'),
      to: getHeader(msg, 'To'),
      subject: getHeader(msg, 'Subject'),
      date: getHeader(msg, 'Date'),
      body: decodeBody(msg),
      isUnread: msg.labelIds?.includes('UNREAD') ?? false,
      inReplyTo: getHeader(msg, 'Message-ID'),
    })),
  }
}
