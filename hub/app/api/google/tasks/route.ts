import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
import { listTaskLists, listTasks, createTask, completeTask } from '@/lib/google'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = await getToken({ req })
  const accessToken = token?.accessToken as string | undefined
  if (!accessToken) {
    return NextResponse.json({ error: 'No Google access token' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const taskListId = searchParams.get('taskListId')

  try {
    if (taskListId) {
      // List tasks within a specific task list
      const showCompleted = searchParams.get('showCompleted') === 'true'
      const maxResults = searchParams.get('maxResults')
      const tasks = await listTasks(accessToken, taskListId, {
        showCompleted,
        maxResults: maxResults ? parseInt(maxResults, 10) : undefined,
      })
      return NextResponse.json({ tasks })
    }

    // List all task lists
    const taskLists = await listTaskLists(accessToken)
    return NextResponse.json({ taskLists })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = await getToken({ req })
  const accessToken = token?.accessToken as string | undefined
  if (!accessToken) {
    return NextResponse.json({ error: 'No Google access token' }, { status: 401 })
  }

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
      if (!title) {
        return NextResponse.json({ error: 'title is required' }, { status: 400 })
      }
      const task = await createTask(accessToken, taskListId, { title, notes, due })
      return NextResponse.json({ task })
    }

    if (action === 'complete') {
      if (!taskId) {
        return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
      }
      const task = await completeTask(accessToken, taskListId, taskId)
      return NextResponse.json({ task })
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
