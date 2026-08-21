import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import { listChatMessagesPage, sendChatMessage } from '@/lib/google'
import { GoogleChatSendSchema } from '@/lib/zod-schemas'
import { requireAiGate, AI_INTENT_HEADER, GATE_TOKEN_HEADER } from '@/lib/requireGate'
import { recordAiAction } from '@/lib/ai-audit'
import { checkActionLimit } from '@/lib/rate-limit'
import { newRequestId } from '@/lib/observability'

export async function GET(req: NextRequest) {
  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(req.url)
  const spaceId = searchParams.get('spaceId')
  const pageSize = parseInt(searchParams.get('pageSize') ?? '50', 10)
  // Optional: scope the read to ONE thread (the panel's thread view). Strict
  // charset check BEFORE it becomes a Google filter expression — quotes/spaces
  // could otherwise rewrite the filter itself. Junk → plain listing.
  const threadNameRaw = searchParams.get('threadName')
  const threadName =
    threadNameRaw && /^spaces\/[\w-]+\/threads\/[\w-]+$/.test(threadNameRaw)
      ? threadNameRaw
      : undefined
  // Continuation token for "Show earlier messages". Opaque to us — bounded and
  // passed through as an encoded query value, never interpreted.
  const pageTokenRaw = searchParams.get('pageToken')
  const pageToken =
    pageTokenRaw && pageTokenRaw.length <= 2048 ? pageTokenRaw : undefined

  if (!spaceId) {
    return NextResponse.json({ error: 'Missing spaceId' }, { status: 400 })
  }

  try {
    const page = await listChatMessagesPage(auth.accessToken, spaceId, pageSize, { threadName, pageToken })
    return NextResponse.json({ messages: page.messages, nextPageToken: page.nextPageToken })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[api/google/chat/messages GET]', msg)

    // Missing Chat scope keeps its dedicated 403 + MISSING_SCOPE code — the
    // client's `missingScope` UX branches on it. Must run BEFORE the generic
    // mapper, which would otherwise fold a 403 into a reauth 401.
    if (msg.includes('403') || msg.includes('insufficientPermissions')) {
      return NextResponse.json(
        { error: 'Google Chat permission not granted.', code: 'MISSING_SCOPE' },
        { status: 403 }
      )
    }

    return googleApiErrorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  // P0-2 (Option B): AI-originated posts (X-AI-Intent present) must carry a
  // valid server-issued quality-gate token — missing/forged/expired/mismatched
  // tokens fail closed. Manual composer posts carry no AI marker and pass.
  const gate = requireAiGate(req.headers, ['post_chat_message'])
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  // AI-action audit context (NS-2). Only AI-originated posts (X-AI-Intent
  // present) are audited + per-action rate-limited; manual posts are untouched.
  const aiIntent = req.headers.get(AI_INTENT_HEADER)
  const isAiAction = aiIntent !== null
  const session = isAiAction ? await getServerSession(authOptions) : null
  const userEmail = (session?.user?.email as string | undefined) ?? null

  try {
    const raw = await req.json()
    const parsed = GoogleChatSendSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 }
      )
    }
    const { spaceId, text, threadName, threadKey } = parsed.data

    // `target` holds routing metadata only — never the message text.
    const auditBase = {
      userEmail,
      actor: 'ai' as const,
      actionType: 'chat_post' as const,
      target: {
        spaceId,
        ...(threadName ? { threadName } : {}),
        ...(threadKey ? { threadKey } : {}),
      },
      intent: aiIntent,
      gateToken: req.headers.get(GATE_TOKEN_HEADER),
      requestId: newRequestId(),
    }

    if (isAiAction) {
      const limit = checkActionLimit(userEmail ?? '', 'chat_post')
      if (!limit.allowed) {
        await recordAiAction({ ...auditBase, status: 'failed', error: 'rate_limited' })
        return NextResponse.json(
          { error: 'Rate limit exceeded for chat_post. Please try again shortly.' },
          { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec ?? 60) } }
        )
      }
    }

    try {
      const message = await sendChatMessage(
        auth.accessToken,
        spaceId,
        text.trim(),
        threadName || threadKey ? { threadName, threadKey } : undefined
      )
      if (isAiAction) await recordAiAction({ ...auditBase, status: 'success' })
      return NextResponse.json({ message })
    } catch (sendErr) {
      if (isAiAction) {
        await recordAiAction({
          ...auditBase,
          status: 'failed',
          error: sendErr instanceof Error ? sendErr.message : 'unknown error',
        })
      }
      throw sendErr
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[api/google/chat/messages POST]', msg)
    return googleApiErrorResponse(err)
  }
}
