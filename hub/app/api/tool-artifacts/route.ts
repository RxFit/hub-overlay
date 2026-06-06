import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import {
  saveToolArtifact,
  getToolArtifacts,
  updateToolArtifact,
  archiveToolArtifact,
} from '@/lib/tool-artifacts'

export const runtime = 'nodejs'

const TENANT_ID = process.env.NEXT_PUBLIC_TENANT_ID || 'rxfit'

/**
 * GET /api/tool-artifacts?toolId=issue-tree
 * Lists artifacts for the current tenant, optionally filtered by tool.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const toolId = req.nextUrl.searchParams.get('toolId') ?? undefined
    const artifacts = await getToolArtifacts(TENANT_ID, toolId)
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
      tenantId: TENANT_ID,
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
