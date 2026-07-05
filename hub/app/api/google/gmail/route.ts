import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import {
  getGmailHeader as getHeader,
  parseGmailThreadMeta as parseThreadMeta,
  type GmailMessage,
  type GmailThread,
} from '@/lib/google'
import { clampInt } from '@/lib/num'
import { extractEmail } from '@/lib/email-address'
import { GoogleGmailSendSchema } from '@/lib/zod-schemas'
import { requireAiGate } from '@/lib/requireGate'

export const runtime = 'nodejs'

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

async function gmailGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
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
    signal: AbortSignal.timeout(10_000),
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

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response
  const accessToken = auth.accessToken

  const { searchParams } = req.nextUrl
  const view = searchParams.get('view') || 'inbox'
  const threadId = searchParams.get('threadId')
  const maxResults = clampInt(searchParams.get('maxResults'), 20, 1, 100)

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
    return googleApiErrorResponse(err)
  }
}

/* ── POST /api/google/gmail — send or reply ── */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response
  const accessToken = auth.accessToken

  // P0-2 (Option B): AI-originated sends (X-AI-Intent present) must carry a
  // valid server-issued quality-gate token — missing/forged/expired/mismatched
  // tokens fail closed. Manual composer sends carry no AI marker and pass.
  const gate = requireAiGate(req.headers, ['send_gmail'])
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  let bodyJson: unknown
  try {
    bodyJson = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = GoogleGmailSendSchema.safeParse(bodyJson)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.issues },
      { status: 400 }
    )
  }
  const { to, subject, message, threadId, inReplyTo } = parsed.data

  // ── Header-injection guard ──
  // Any value interpolated into an RFC-2822 header line must not contain
  // CR/LF, or an attacker could inject extra headers (e.g. a silent Bcc).
  const stripHeader = (v: unknown): string => String(v ?? '').replace(/[\r\n]+/g, ' ').trim()
  const cleanInReplyTo = inReplyTo ? stripHeader(inReplyTo) : ''

  // Validate every recipient address (comma-separated list supported).
  // Extract the bare address first so bare addresses and simple `Name <addr>`
  // forms are normalized before validation. Quoted display names containing a
  // comma (`"Lopez, Maria" <m@x.com>`) are split apart here and rejected —
  // not supported at the route layer, which fails closed.
  const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/
  const recipients = stripHeader(to).split(',').map(r => extractEmail(r)).filter(Boolean)
  if (recipients.length === 0 || !recipients.every(r => EMAIL_RE.test(r))) {
    return NextResponse.json({ error: 'Invalid recipient address' }, { status: 400 })
  }
  const cleanTo = recipients.join(', ')

  const from = session.user.email ?? ''
  const subjectLine = stripHeader(subject || (cleanInReplyTo ? `Re: ${cleanInReplyTo}` : '(no subject)'))

  // Build RFC 2822 email
  const emailLines = [
    `From: ${from}`,
    `To: ${cleanTo}`,
    `Subject: ${subjectLine}`,
    ...(cleanInReplyTo ? [`In-Reply-To: ${cleanInReplyTo}`, `References: ${cleanInReplyTo}`] : []),
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
    return googleApiErrorResponse(err)
  }
}

/* ── Parsers ──
   GmailThread/GmailMessage types plus the getHeader/parseThreadMeta helpers
   now live in @/lib/google (shared with the AI context builder). Only the
   full-body parsing used by the thread view remains route-local. */

function decodeBody(msg: GmailMessage): string {
  const data =
    msg.payload?.body?.data ||
    msg.payload?.parts?.find(p => p.mimeType === 'text/plain')?.body?.data ||
    ''
  if (!data) return msg.snippet ?? ''
  return Buffer.from(data, 'base64').toString('utf-8')
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
