import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleWriteErrorResponse } from '@/lib/google-session'
import { createGooglePresentation } from '@/lib/google'
import { AI_INTENT_HEADER } from '@/lib/requireGate'
import { recordAiAction } from '@/lib/ai-audit'
import { checkActionLimit } from '@/lib/rate-limit'
import { newRequestId } from '@/lib/observability'

export const runtime = 'nodejs'

/**
 * POST /api/google/presentation — create a Google Slides deck in the caller's
 * own Drive. Same posture as the Doc/Sheet routes: confirm-card gated, AI calls
 * audited + rate-limited, MISSING_SCOPE surfaced for grants predating the
 * `presentations`/`drive.file` scopes.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  let body: { title?: string; body?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const title = (body.title || '').trim()
  if (!title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 })
  }

  const aiIntent = req.headers.get(AI_INTENT_HEADER)
  const isAiAction = aiIntent !== null
  const email = session.user.email ?? ''
  const auditBase = {
    userEmail: email || null,
    actor: 'ai' as const,
    actionType: 'presentation_create' as const,
    target: {} as Record<string, unknown>,
    intent: aiIntent,
    gateToken: null,
    requestId: newRequestId(),
  }

  if (isAiAction) {
    const limit = checkActionLimit(email, 'presentation_create')
    if (!limit.allowed) {
      await recordAiAction({ ...auditBase, status: 'failed', error: 'rate_limited' })
      return NextResponse.json(
        { error: 'Rate limit exceeded for presentation_create. Please try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec ?? 60) } },
      )
    }
  }

  try {
    const presentation = await createGooglePresentation(auth.accessToken, { title, body: body.body })
    if (isAiAction) {
      await recordAiAction({ ...auditBase, target: { presentationId: presentation.presentationId }, status: 'success' })
    }
    return NextResponse.json({ presentation })
  } catch (err) {
    if (isAiAction) {
      await recordAiAction({
        ...auditBase,
        status: 'failed',
        error: err instanceof Error ? err.message : 'unknown error',
      })
    }
    return googleWriteErrorResponse(err, 'Google Slides')
  }
}
