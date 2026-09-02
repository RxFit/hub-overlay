import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse, googleRouteCtx } from '@/lib/google-session'
import { createTask, parseGmailThreadMeta, GMAIL_TRIAGE_HEADER_QS, type GmailThread } from '@/lib/google'
import { GoogleGmailActionSchema } from '@/lib/zod-schemas'
import { buildTaskNotes, GMAIL_THREAD_ID_RE } from '@/lib/gmail-actions'
import { requireAiGate, AI_INTENT_HEADER, GATE_TOKEN_HEADER } from '@/lib/requireGate'
import { recordAiAction } from '@/lib/ai-audit'
import { checkActionLimit } from '@/lib/rate-limit'
import { newRequestId } from '@/lib/observability'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

/* ══════════════════════════════════════════════════════════════════════════════
   GMAIL THREAD ACTIONS
   POST /api/google/gmail/actions

   The email action menu's write endpoint:
   - action: 'trash'     → move the thread to Gmail Trash (recoverable — never
                           a permanent delete).
   - action: 'save_task' → create a Google Task in the user's default list with
                           the email subject as title and sender/snippet/link
                           as notes.

   Mirrors the send route's write posture: session auth + resolveGoogleAuth,
   zod-validated body, and the manual-vs-AI split — human taps carry no AI
   marker and pass the gate untouched; any future AI-originated call must
   present a valid gate token (requireAiGate) and is audited + rate-limited
   exactly like AI sends.
   ══════════════════════════════════════════════════════════════════════════════ */

export const POST = withFault('google/gmail/actions', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response
  const accessToken = auth.accessToken

  let bodyJson: unknown
  try {
    bodyJson = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = GoogleGmailActionSchema.safeParse(bodyJson)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.issues },
      { status: 400 }
    )
  }
  const { action, threadId, subject, from, snippet } = parsed.data

  // Path-injection guard: the id is interpolated into the Gmail API URL.
  if (!GMAIL_THREAD_ID_RE.test(threadId)) {
    return NextResponse.json({ error: 'Invalid thread id' }, { status: 400 })
  }

  // AI-originated calls (X-AI-Intent present) must carry a valid gate token;
  // manual taps have no AI marker and pass (same contract as the send route).
  const auditActionType = action === 'trash' ? 'gmail_trash' : 'task_create'
  const gate = requireAiGate(req.headers, [auditActionType])
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  const userEmail = session.user.email ?? ''
  const aiIntent = req.headers.get(AI_INTENT_HEADER)
  const isAiAction = aiIntent !== null
  const auditBase = {
    userEmail: userEmail || null,
    actor: 'ai' as const,
    actionType: auditActionType,
    target: { threadId },
    intent: aiIntent,
    gateToken: req.headers.get(GATE_TOKEN_HEADER),
    requestId: newRequestId(),
  }

  if (isAiAction) {
    const limit = checkActionLimit(userEmail, auditActionType)
    if (!limit.allowed) {
      await recordAiAction({ ...auditBase, status: 'failed', error: 'rate_limited' })
      return NextResponse.json(
        { error: `Rate limit exceeded for ${auditActionType}. Please try again shortly.` },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec ?? 60) } }
      )
    }
  }

  try {
    if (action === 'trash') {
      const res = await fetch(`${GMAIL_BASE}/threads/${threadId}/trash`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown')
        throw new Error(`Gmail API ${res.status}: ${text}`)
      }
      if (isAiAction) await recordAiAction({ ...auditBase, status: 'success' })
      return NextResponse.json({ ok: true, action: 'trash', threadId })
    }

    // save_task — resolve subject/from/snippet SERVER-SIDE from the actual
    // thread (also proves the thread exists and belongs to this user) instead
    // of trusting the client body; client fields are only a fallback for the
    // degenerate empty-thread case. '@default' is the Tasks API alias for the
    // user's default list.
    const metaRes = await fetch(
      `${GMAIL_BASE}/threads/${threadId}?format=metadata&${GMAIL_TRIAGE_HEADER_QS}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) }
    )
    if (!metaRes.ok) {
      const text = await metaRes.text().catch(() => 'unknown')
      throw new Error(`Gmail API ${metaRes.status}: ${text}`)
    }
    const meta = parseGmailThreadMeta((await metaRes.json()) as GmailThread)

    const task = await createTask(accessToken, '@default', {
      title: (meta?.subject ?? subject ?? '').trim() || '(no subject)',
      notes: buildTaskNotes({
        from: meta?.from ?? from,
        snippet: meta?.snippet ?? snippet,
        threadId,
      }),
    })
    if (isAiAction) await recordAiAction({ ...auditBase, status: 'success' })
    return NextResponse.json({ ok: true, action: 'save_task', threadId, taskId: task.id })
  } catch (err) {
    if (isAiAction) {
      await recordAiAction({
        ...auditBase,
        status: 'failed',
        error: err instanceof Error ? err.message : 'unknown error',
      })
    }
    return googleApiErrorResponse(err, googleRouteCtx(req, '/api/google/gmail/actions'))
  }
})
