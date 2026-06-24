import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import { clampInt } from '@/lib/num'
import { GoogleTaskCreateSchema } from '@/lib/zod-schemas'
import { listTaskLists, listTasks, createTask, completeTask, uncompleteTask } from '@/lib/google'

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
      const task = await createTask(accessToken, taskListId, parsed.data)
      return NextResponse.json({ task })
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

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (error) {
    return googleApiErrorResponse(error)
  }
}
