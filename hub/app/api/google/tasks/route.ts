import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import { clampInt } from '@/lib/num'
import { GoogleTaskCreateSchema } from '@/lib/zod-schemas'
import { listTaskLists, listTasks, createTask, completeTask, uncompleteTask, updateTask, deleteTask } from '@/lib/google'
import { AI_INTENT_HEADER, GATE_TOKEN_HEADER } from '@/lib/requireGate'
import { recordAiAction } from '@/lib/ai-audit'
import { checkActionLimit } from '@/lib/rate-limit'
import { newRequestId } from '@/lib/observability'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response
  const accessToken = auth.accessToken

  const { searchParams } = new URL(req.url)
  const taskListId = searchParams.get('taskListId')

  try {
    if (taskListId) {
      // List tasks within a specific task list
      const showCompleted = searchParams.get('showCompleted') === 'true'
      const maxResults = searchParams.get('maxResults')
      const tasks = await listTasks(accessToken, taskListId, {
        showCompleted,
        maxResults: maxResults ? clampInt(maxResults, 100, 1, 100) : undefined,
      })
      return NextResponse.json({ tasks })
    }

    // List all task lists
    const taskLists = await listTaskLists(accessToken)
    return NextResponse.json({ taskLists })
  } catch (error) {
    return googleApiErrorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response
  const accessToken = auth.accessToken

  let body: { action: string; taskListId: string; taskId?: string; title?: string; notes?: string; due?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { action, taskListId, taskId, title, notes, due } = body

  if (!taskListId) {
    return NextResponse.json({ error: 'taskListId is required' }, { status: 400 })
  }

  try {
    if (action === 'create') {
      const parsed = GoogleTaskCreateSchema.safeParse({ title, notes, due })
      if (!parsed.success) {
        return NextResponse.json(
          { error: 'Validation failed', details: parsed.error.issues },
          { status: 400 }
        )
      }

      // AI-action audit trail (NS-2). Only AI-originated task creations
      // (X-AI-Intent present) are audited + per-action rate-limited. `target`
      // keeps routing metadata only (taskListId / created taskId) — never the
      // title or notes.
      const aiIntent = req.headers.get(AI_INTENT_HEADER)
      const isAiAction = aiIntent !== null
      const email = session.user.email ?? ''
      const auditBase = {
        userEmail: email || null,
        actor: 'ai' as const,
        actionType: 'task_create' as const,
        target: { taskListId } as Record<string, unknown>,
        intent: aiIntent,
        gateToken: req.headers.get(GATE_TOKEN_HEADER),
        requestId: newRequestId(),
      }

      if (isAiAction) {
        const limit = checkActionLimit(email, 'task_create')
        if (!limit.allowed) {
          await recordAiAction({ ...auditBase, status: 'failed', error: 'rate_limited' })
          return NextResponse.json(
            { error: 'Rate limit exceeded for task_create. Please try again shortly.' },
            { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec ?? 60) } }
          )
        }
      }

      try {
        const task = await createTask(accessToken, taskListId, parsed.data)
        if (isAiAction) {
          const taskId = (task as { id?: string })?.id
          await recordAiAction({
            ...auditBase,
            target: { taskListId, ...(taskId ? { taskId } : {}) },
            status: 'success',
          })
        }
        return NextResponse.json({ task })
      } catch (createErr) {
        if (isAiAction) {
          await recordAiAction({
            ...auditBase,
            status: 'failed',
            error: createErr instanceof Error ? createErr.message : 'unknown error',
          })
        }
        throw createErr
      }
    }

    if (action === 'complete') {
      if (!taskId) {
        return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
      }
      const task = await completeTask(accessToken, taskListId, taskId)
      return NextResponse.json({ task })
    }

    if (action === 'uncomplete') {
      if (!taskId) {
        return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
      }
      const task = await uncompleteTask(accessToken, taskListId, taskId)
      return NextResponse.json({ task })
    }

    if (action === 'update') {
      if (!taskId) {
        return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
      }
      const patch: { title?: string; notes?: string; due?: string } = {}
      if (typeof title === 'string' && title.trim()) patch.title = title.trim()
      if (typeof notes === 'string') patch.notes = notes
      if (typeof due === 'string' && due.trim()) patch.due = due.trim()
      if (Object.keys(patch).length === 0) {
        return NextResponse.json({ error: 'Nothing to update — provide title, notes, or due' }, { status: 400 })
      }
      const task = await updateTask(accessToken, taskListId, taskId, patch)
      return NextResponse.json({ task })
    }

    if (action === 'delete') {
      if (!taskId) {
        return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
      }
      await deleteTask(accessToken, taskListId, taskId)
      return NextResponse.json({ deleted: true })
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (error) {
    return googleApiErrorResponse(error)
  }
}
