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
import { GoogleGmailSendSchema, GoogleGmailSendDraftSchema } from '@/lib/zod-schemas'
import { encodeMimeMessage, parseRecipientList, stripHeader } from '@/lib/gmail-mime'
import { requireAiGate, AI_INTENT_HEADER, GATE_TOKEN_HEADER } from '@/lib/requireGate'
import { recordAiAction } from '@/lib/ai-audit'
import { checkActionLimit } from '@/lib/rate-limit'
import { newRequestId } from '@/lib/observability'
import { resolveSubject } from '@/lib/gmail-subject'

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
  // Gmail list-page cursor (opaque token from a previous response). Validated
  // before URL interpolation.
  const pageTokenRaw = searchParams.get('pageToken')
  const pageToken = pageTokenRaw && /^[A-Za-z0-9_=-]{1,512}$/.test(pageTokenRaw) ? pageTokenRaw : null

  try {
    // Return a specific thread
    if (threadId) {
      const thread = await gmailGet<GmailThread>(`/threads/${threadId}?format=full`, accessToken)
      return NextResponse.json({ thread: parseThread(thread) })
    }

    // Return inbox thread list
    const label = view === 'sent' ? 'SENT' : view === 'unread' ? 'UNREAD' : 'INBOX'
    const list = await gmailGet<{ threads?: { id: string; snippet: string }[]; nextPageToken?: string; resultSizeEstimate: number }>(
      `/threads?labelIds=${label}&maxResults=${maxResults}${pageToken ? `&pageToken=${pageToken}` : ''}`,
      accessToken
    )

    if (!list.threads?.length) {
      return NextResponse.json({ threads: [], unreadCount: 0, nextPageToken: null })
    }

    // Fetch metadata for each thread in parallel
    const threads = await Promise.all(
      list.threads.map(t =>
        gmailGet<GmailThread>(`/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, accessToken)
          .then(parseThreadMeta)
          .catch(() => null)
      )
    )

    // Get unread count (first page only — pagination requests reuse the badge)
    let unreadCount = 0
    if (!pageToken) try {
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
      nextPageToken: list.nextPageToken ?? null,
    })
  } catch (err) {
    return googleApiErrorResponse(err)
  }
}

/**
 * Deliver a draft created by an earlier `mode: 'draft'` call.
 *
 * This is where the send actually happens, so this is where the audit row and
 * the rate limit belong — creating a draft delivers nothing and is neither.
 *
 * On failure the draft is left in place ON PURPOSE. That is the whole point of
 * drafts-first: a delivery that fails leaves recoverable content in the user's
 * Gmail rather than losing what the assistant composed. The error says so, so
 * the user is told where to find it instead of being asked to start over.
 */
async function sendExistingDraft(
  req: NextRequest,
  draftId: string,
  accessToken: string,
  userEmail: string,
): Promise<NextResponse> {
  const aiIntent = req.headers.get(AI_INTENT_HEADER)
  const isAiAction = aiIntent !== null
  const auditBase = {
    userEmail: userEmail || null,
    actor: 'ai' as const,
    actionType: 'gmail_send' as const,
    target: { draftId },
    intent: aiIntent,
    gateToken: req.headers.get(GATE_TOKEN_HEADER),
    requestId: newRequestId(),
  }

  if (isAiAction) {
    const limit = checkActionLimit(userEmail, 'gmail_send')
    if (!limit.allowed) {
      await recordAiAction({ ...auditBase, status: 'failed', error: 'rate_limited' })
      return NextResponse.json(
        { error: 'Rate limit exceeded for gmail_send. Please try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec ?? 60) } },
      )
    }
  }

  try {
    const sent = await gmailPost<{ id: string; threadId: string }>(
      '/drafts/send',
      accessToken,
      { id: draftId },
    )
    if (isAiAction) await recordAiAction({ ...auditBase, status: 'success' })
    return NextResponse.json({ sent: true, messageId: sent.id, threadId: sent.threadId })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    if (isAiAction) await recordAiAction({ ...auditBase, status: 'failed', error: message })
    if (message.includes('401') || message.includes('403')) return googleApiErrorResponse(err)
    return NextResponse.json(
      {
        error: `Could not send the email. It is saved in your Gmail drafts — nothing was lost. (${message})`,
        draftId,
      },
      { status: 502 },
    )
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

  // ── Phase 2 of drafts-first: send a draft that already exists ──
  // Checked before the compose schema because the two bodies are disjoint —
  // this one carries a draftId and no recipient. It is the side-effecting half,
  // so it carries the SAME gate (already applied above), rate limit and audit
  // row that a direct send does.
  const draftSend = GoogleGmailSendDraftSchema.safeParse(bodyJson)
  if (draftSend.success) {
    return sendExistingDraft(req, draftSend.data.draftId, accessToken, session.user.email ?? '')
  }

  const parsed = GoogleGmailSendSchema.safeParse(bodyJson)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.issues },
      { status: 400 }
    )
  }
  const { to, subject, message, threadId, inReplyTo, mode = 'send' } = parsed.data

  // ── Header-injection guard + recipient validation ──
  // Both now live in lib/gmail-mime.ts, shared with the draft path so the two
  // cannot drift, and unit-tested there (this logic is security-relevant and
  // previously had no direct tests).
  const parsedRecipients = parseRecipientList(to)
  if (!parsedRecipients.ok) {
    return NextResponse.json({ error: 'Invalid recipient address' }, { status: 400 })
  }
  const cleanTo = parsedRecipients.value

  const from = session.user.email ?? ''
  // Deliberately does NOT derive a subject from `inReplyTo` — that is a
  // Message-ID, not a subject. See lib/gmail-subject.ts for the full rationale.
  const subjectLine = stripHeader(resolveSubject(subject))

  // ── AI-action audit trail (NS-2) ──
  // When the request is AI-originated (X-AI-Intent present), every send writes
  // exactly one append-only provenance row (success or failure). Manual
  // composer sends carry no AI marker and are not audited or per-action limited.
  // `target` holds routing metadata only — never the subject or message body.
  const aiIntent = req.headers.get(AI_INTENT_HEADER)
  const isAiAction = aiIntent !== null
  const auditBase = {
    userEmail: from || session.user.email || null,
    actor: 'ai' as const,
    actionType: 'gmail_send' as const,
    target: { to: cleanTo, ...(threadId ? { threadId } : {}) },
    intent: aiIntent,
    gateToken: req.headers.get(GATE_TOKEN_HEADER),
    requestId: newRequestId(),
  }

  if (isAiAction) {
    const limit = checkActionLimit(from, 'gmail_send')
    if (!limit.allowed) {
      await recordAiAction({ ...auditBase, status: 'failed', error: 'rate_limited' })
      return NextResponse.json(
        { error: 'Rate limit exceeded for gmail_send. Please try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec ?? 60) } }
      )
    }
  }

  const raw = encodeMimeMessage({
    from,
    to: cleanTo,
    subject: subjectLine,
    inReplyTo,
    body: message,
  })

  try {
    const payload: Record<string, string> = { raw }
    if (threadId) payload.threadId = threadId

    // ── Draft mode: create, don't send ──
    //
    // §6.1 "drafts-first". The value is in the failure case: a composed email
    // that fails at the delivery step is otherwise lost entirely, and the user
    // has to ask the assistant to write it again. Created as a draft, it is
    // sitting in Gmail regardless of what happens next.
    //
    // Deliberately NOT audited as a send and NOT rate-limited as one — creating
    // a draft delivers nothing to anybody. The subsequent send is the
    // side-effecting act, and that is where both apply.
    if (mode === 'draft') {
      const draft = await gmailPost<{ id: string; message?: { id: string; threadId: string } }>(
        '/drafts',
        accessToken,
        { message: payload },
      )
      return NextResponse.json({
        sent: false,
        draftId: draft.id,
        threadId: draft.message?.threadId,
        to: cleanTo,
        subject: subjectLine,
      })
    }

    const sent = await gmailPost<{ id: string; threadId: string }>('/messages/send', accessToken, payload)

    // Mark thread as read if replying
    if (threadId) {
      await gmailPost(`/threads/${threadId}/modify`, accessToken, {
        removeLabelIds: ['UNREAD'],
      }).catch(() => {})
    }

    if (isAiAction) await recordAiAction({ ...auditBase, status: 'success' })
    return NextResponse.json({ sent: true, messageId: sent.id, threadId: sent.threadId })
  } catch (err) {
    if (isAiAction) {
      await recordAiAction({
        ...auditBase,
        status: 'failed',
        error: err instanceof Error ? err.message : 'unknown error',
      })
    }
    return googleApiErrorResponse(err)
  }
}

/* ── Parsers ──
   GmailThread/GmailMessage types plus the getHeader/parseThreadMeta helpers
   now live in @/lib/google (shared with the AI context builder). Only the
   full-body parsing used by the thread view remains route-local. */

type GmailPart = NonNullable<NonNullable<GmailMessage['payload']>['parts']>[number] & {
  parts?: GmailPart[]
}

/** Depth-first search for a MIME part (multipart/alternative bodies nest
 *  inside multipart/mixed and multipart/related, so a flat find() misses
 *  the HTML part of most real-world newsletters). */
function findPart(parts: GmailPart[] | undefined, mimeType: string): GmailPart | null {
  for (const p of parts ?? []) {
    if (p.mimeType === mimeType && p.body?.data) return p
    const nested = findPart(p.parts, mimeType)
    if (nested) return nested
  }
  return null
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Decode a message body for the thread view, PREFERRING text/html so
 *  designed emails (newsletters, graphics, styled sign-offs) render as
 *  authored; plain-text bodies are escaped and newline-preserved. The
 *  client sanitizes before rendering either way. */
function decodeBody(msg: GmailMessage): string {
  const payload = msg.payload
  const parts = payload?.parts as GmailPart[] | undefined

  const htmlData =
    (payload?.mimeType === 'text/html' ? payload?.body?.data : undefined) ||
    findPart(parts, 'text/html')?.body?.data
  if (htmlData) return Buffer.from(htmlData, 'base64').toString('utf-8')

  const plainData =
    (payload?.mimeType === 'text/plain' ? payload?.body?.data : undefined) ||
    payload?.body?.data ||
    findPart(parts, 'text/plain')?.body?.data
  if (!plainData) return escapeHtml(msg.snippet ?? '')
  const text = Buffer.from(plainData, 'base64').toString('utf-8')
  return `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`
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
