import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleWriteErrorResponse, googleRouteCtx } from '@/lib/google-session'
import { createDocFromMarkdown } from '@/lib/google/docs'
import { resolveArtifactFolder } from '@/lib/google/artifact-folder'
import { AI_INTENT_HEADER } from '@/lib/requireGate'
import { recordAiAction } from '@/lib/ai-audit'
import { checkActionLimit } from '@/lib/rate-limit'
import { newRequestId } from '@/lib/observability'

export const runtime = 'nodejs'

/**
 * POST /api/google/doc — create a Google Doc in the caller's own Drive.
 *
 * Personal-productivity write (own account), so it mirrors the Tasks route:
 * human confirm-card approval is the gate; AI-originated calls carry X-AI-Intent
 * and are audited + rate-limited. No HMAC gate token (not high-stakes). A grant
 * predating the `documents`/`drive.file` scope surfaces as MISSING_SCOPE so the
 * client can prompt a one-time re-consent.
 *
 * `body` is treated as MARKDOWN and converted by Drive into real Doc formatting
 * (headings, bold, lists, tables, links) — plain text still works, since plain
 * text is valid markdown. The file is filed into the Hub workspace's
 * `Documents/` folder; if that folder can't be provisioned the doc is still
 * created, just at Drive root.
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
    actionType: 'doc_create' as const,
    target: {} as Record<string, unknown>,
    intent: aiIntent,
    gateToken: null,
    requestId: newRequestId(),
  }

  if (isAiAction) {
    const limit = checkActionLimit(email, 'doc_create')
    if (!limit.allowed) {
      await recordAiAction({ ...auditBase, status: 'failed', error: 'rate_limited' })
      return NextResponse.json(
        { error: 'Rate limit exceeded for doc_create. Please try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec ?? 60) } },
      )
    }
  }

  try {
    const { folderId, tenantId } = await resolveArtifactFolder(auth.accessToken, email, 'documents')
    const doc = await createDocFromMarkdown(auth.accessToken, {
      title,
      markdown: body.body,
      folderId,
      tenantId,
    })
    if (isAiAction) {
      await recordAiAction({ ...auditBase, target: { documentId: doc.documentId }, status: 'success' })
    }
    return NextResponse.json({ doc })
  } catch (err) {
    if (isAiAction) {
      await recordAiAction({
        ...auditBase,
        status: 'failed',
        error: err instanceof Error ? err.message : 'unknown error',
      })
    }
    return googleWriteErrorResponse(err, 'Google Docs', googleRouteCtx(req, '/api/google/doc'))
  }
}
