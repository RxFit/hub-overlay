import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import {
  saveToolArtifact,
  getToolArtifacts,
  getToolArtifact,
  updateToolArtifact,
  archiveToolArtifact,
} from '@/lib/tool-artifacts'
import { getTenantId } from '@/lib/tenant-context'

export const runtime = 'nodejs'

// Phase 1 (multi-tenancy): resolved per-request via getTenantId().
// When middleware sets x-tenant-id from hostname, this will auto-resolve.

/**
 * GET /api/tool-artifacts?toolId=issue-tree
 * Lists artifacts for the current tenant, optionally filtered by tool.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Onboarding users have no artifact access (consistent with the rest of the app).
  const role = (session.user as Record<string, unknown>)?.role as string | undefined
  if (!role || role === 'onboarding') {
    return NextResponse.json({ artifacts: [] })
  }

  try {
    const toolId = req.nextUrl.searchParams.get('toolId') ?? undefined
    // Admins see all tenant artifacts; staff are scoped to artifacts they created.
    const isAdmin = role === 'admin' || role === 'superadmin'
    const createdBy = isAdmin ? undefined : (session.user.email ?? '__none__')
    const TENANT_ID = getTenantId()
    const artifacts = await getToolArtifacts(TENANT_ID, toolId, 20, createdBy)
    return NextResponse.json({ artifacts })
  } catch (err) {
    console.error('[tool-artifacts GET]', err)
    return NextResponse.json({ error: 'Failed to load tool artifacts' }, { status: 500 })
  }
}

/**
 * POST /api/tool-artifacts
 * Creates a new tool artifact. Body: { toolId, title, content, contextSummary?, chatId? }
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { toolId, title, content, contextSummary, chatId } = body

    if (!toolId || !title || content === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: toolId, title, content' },
        { status: 400 },
      )
    }

    const artifact = await saveToolArtifact({
      tenantId: getTenantId(),
      toolId,
      chatId: chatId ?? undefined,
      title,
      content,
      contextSummary: contextSummary ?? undefined,
      createdBy: session.user.email ?? undefined,
    })

    return NextResponse.json({ artifact }, { status: 201 })
  } catch (err) {
    console.error('[tool-artifacts POST]', err)
    return NextResponse.json({ error: 'Failed to save tool artifact' }, { status: 500 })
  }
}

/**
 * PATCH /api/tool-artifacts
 * Updates an existing artifact. Body: { id, content?, title? }
 */
export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { id, content, title } = body

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }
    if (content === undefined && title === undefined) {
      return NextResponse.json({ error: 'Nothing to update — provide content or title' }, { status: 400 })
    }

    // Verify artifact belongs to this tenant (IDOR prevention)
    const existing = await getToolArtifact(id)
    if (!existing || existing.tenantId !== getTenantId()) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 })
    }

    const artifact = await updateToolArtifact(id, content, title)

    if (!artifact) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 })
    }

    return NextResponse.json({ artifact })
  } catch (err) {
    console.error('[tool-artifacts PATCH]', err)
    return NextResponse.json({ error: 'Failed to update tool artifact' }, { status: 500 })
  }
}

/**
 * DELETE /api/tool-artifacts
 * Archives (soft-deletes) an artifact. Body: { id }
 */
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { id } = body

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }

    // Verify artifact belongs to this tenant (IDOR prevention)
    const existing = await getToolArtifact(id)
    if (!existing || existing.tenantId !== getTenantId()) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 })
    }

    const archived = await archiveToolArtifact(id)

    if (!archived) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[tool-artifacts DELETE]', err)
    return NextResponse.json({ error: 'Failed to archive tool artifact' }, { status: 500 })
  }
}
