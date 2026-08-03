import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleWriteErrorResponse, googleApiErrorResponse } from '@/lib/google-session'
import {
  findShareableFiles,
  listFileAccess,
  grantFileAccess,
  grantLinkAccess,
  revokeFileAccess,
  normalizeShareRole,
  type GrantResult,
} from '@/lib/google/sharing'
import { GoogleShareSchema, GoogleUnshareSchema } from '@/lib/zod-schemas'
import { requireAiGate, AI_INTENT_HEADER, GATE_TOKEN_HEADER } from '@/lib/requireGate'
import { recordAiAction } from '@/lib/ai-audit'
import { checkActionLimit } from '@/lib/rate-limit'
import { newRequestId } from '@/lib/observability'
import { getTenantId } from '@/lib/tenant-context'

export const runtime = 'nodejs'

/**
 * /api/google/share — read and change WHO can open a Drive file.
 *
 * ── Why this is gated harder than /api/google/doc ──
 * Creating a Doc writes to the caller's own Drive and nobody else sees it. A
 * share is outward-facing: it hands business content to a named third party and
 * cannot be un-sent (the notification mail is already gone even if the grant is
 * revoked a second later). That puts it in the same class as `send_gmail` and
 * `post_chat_message`, so it carries the same protections — the HMAC gate token
 * verified server-side via `requireAiGate`, per-action rate limiting, and an
 * `ai_action_log` row for every attempt.
 *
 * ── The capability boundary ──
 * GRANT/REVOKE need `drive.file`, which covers only files the Hub created; the
 * lookup in GET marks which files those are so the client can explain the limit
 * before asking the user to approve anything. READING access needs only
 * `drive.readonly` and therefore works on any file the user can see.
 */

const ALLOWED_INTENTS = ['share_google_file'] as const

/* ── GET ──
 * ?q=<name>     → candidate files ({ managed, unmanaged })
 * ?fileId=<id>  → who currently has access
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  const { searchParams } = req.nextUrl
  const fileId = searchParams.get('fileId')
  const query = searchParams.get('q')

  try {
    if (fileId) {
      const access = await listFileAccess(auth.accessToken, fileId)
      return NextResponse.json({ access })
    }

    if (query && query.trim()) {
      const matches = await findShareableFiles(auth.accessToken, query, {
        tenantId: getTenantId(),
      })
      return NextResponse.json(matches)
    }

    return NextResponse.json({ error: 'Provide either q or fileId' }, { status: 400 })
  } catch (err) {
    return googleApiErrorResponse(err)
  }
}

/* ── POST — grant access ── */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Fails closed on a missing/forged/expired/mismatched gate token for any
  // AI-originated call. A human-driven call (no X-AI-Intent) is unaffected.
  const gate = requireAiGate(req.headers, ALLOWED_INTENTS)
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = GoogleShareSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request body' },
      { status: 400 },
    )
  }
  const body = parsed.data

  const aiIntent = req.headers.get(AI_INTENT_HEADER)
  const isAiAction = aiIntent !== null
  const email = session.user.email ?? ''
  const role = normalizeShareRole(body.role)

  const auditBase = {
    userEmail: email || null,
    actor: 'ai' as const,
    actionType: 'file_share' as const,
    target: {
      fileId: body.fileId,
      role,
      ...(body.link ? { link: true } : { recipients: body.recipients }),
    } as Record<string, unknown>,
    intent: aiIntent,
    gateToken: req.headers.get(GATE_TOKEN_HEADER),
    requestId: newRequestId(),
  }

  if (isAiAction) {
    const limit = checkActionLimit(email, 'file_share')
    if (!limit.allowed) {
      await recordAiAction({ ...auditBase, status: 'failed', error: 'rate_limited' })
      return NextResponse.json(
        { error: 'Rate limit exceeded for file sharing. Please try again shortly.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec ?? 60) } },
      )
    }
  }

  try {
    const granted: GrantResult[] = []

    if (body.link) {
      granted.push(await grantLinkAccess(auth.accessToken, body.fileId, role))
    } else {
      // Sequential, not Promise.all: Drive counts each grant separately against
      // the per-user write quota, and a parallel burst on a multi-recipient
      // share is exactly the pattern that draws a 429. Recipient lists here are
      // small (capped at 25 by the schema), so the latency cost is negligible.
      for (const recipient of body.recipients ?? []) {
        granted.push(
          await grantFileAccess(auth.accessToken, body.fileId, {
            email: recipient,
            role,
            notify: body.notify,
            message: body.message,
          }),
        )
      }
    }

    if (isAiAction) {
      await recordAiAction({
        ...auditBase,
        target: { ...auditBase.target, granted: granted.map(g => g.grantee) },
        status: 'success',
      })
    }
    return NextResponse.json({ granted })
  } catch (err) {
    if (isAiAction) {
      await recordAiAction({
        ...auditBase,
        status: 'failed',
        error: err instanceof Error ? err.message : 'unknown error',
      })
    }
    return googleWriteErrorResponse(err, 'Google Drive sharing')
  }
}

/* ── DELETE — revoke one grant ── */
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const gate = requireAiGate(req.headers, ALLOWED_INTENTS)
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  const { searchParams } = req.nextUrl
  const parsed = GoogleUnshareSchema.safeParse({
    fileId: searchParams.get('fileId') ?? '',
    permissionId: searchParams.get('permissionId') ?? '',
  })
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'fileId and permissionId are both required' },
      { status: 400 },
    )
  }

  const aiIntent = req.headers.get(AI_INTENT_HEADER)
  const isAiAction = aiIntent !== null
  const auditBase = {
    userEmail: session.user.email ?? null,
    actor: 'ai' as const,
    actionType: 'file_unshare' as const,
    target: { ...parsed.data } as Record<string, unknown>,
    intent: aiIntent,
    gateToken: req.headers.get(GATE_TOKEN_HEADER),
    requestId: newRequestId(),
  }

  try {
    await revokeFileAccess(auth.accessToken, parsed.data.fileId, parsed.data.permissionId)
    if (isAiAction) await recordAiAction({ ...auditBase, status: 'success' })
    return NextResponse.json({ revoked: true })
  } catch (err) {
    if (isAiAction) {
      await recordAiAction({
        ...auditBase,
        status: 'failed',
        error: err instanceof Error ? err.message : 'unknown error',
      })
    }
    return googleWriteErrorResponse(err, 'Google Drive sharing')
  }
}
