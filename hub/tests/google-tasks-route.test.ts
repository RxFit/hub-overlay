import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/google/tasks — route-owned logic (NS-11).

   Mocking boundary: next-auth session/JWT + `lib/google` (the Google Tasks
   fetch layer). Everything the ROUTE decides runs real: param validation,
   action dispatch, zod bounds, the NS-2 audit contract (captured), the real
   rate limiter driven to breach, and `googleApiErrorResponse` status mapping.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    token: null as unknown,
    auditRows: [] as Record<string, unknown>[],
    google: {
      listTaskLists: vi.fn(),
      listTasks: vi.fn(),
      createTask: vi.fn(),
      completeTask: vi.fn(),
      uncompleteTask: vi.fn(),
    },
  },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => state.token) }))
vi.mock('@/lib/ai-audit', () => ({
  recordAiAction: vi.fn(async (row: Record<string, unknown>) => {
    state.auditRows.push(row)
  }),
}))
vi.mock('@/lib/google', () => ({
  listTaskLists: (...a: unknown[]) => state.google.listTaskLists(...a),
  listTasks: (...a: unknown[]) => state.google.listTasks(...a),
  createTask: (...a: unknown[]) => state.google.createTask(...a),
  completeTask: (...a: unknown[]) => state.google.completeTask(...a),
  uncompleteTask: (...a: unknown[]) => state.google.uncompleteTask(...a),
}))

import { GET, POST } from '@/app/api/google/tasks/route'
import { _reset as resetRateLimit, ACTION_LIMITS } from '@/lib/rate-limit'

function getReq(qs = '') {
  return new NextRequest(`http://localhost/api/google/tasks${qs}`)
}
function postReq(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/google/tasks', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })
}

beforeEach(() => {
  state.session = { user: { email: 'danny@rxfitatx.com' } }
  state.token = { accessToken: 'goog-token' }
  state.auditRows = []
  for (const fn of Object.values(state.google)) fn.mockReset()
  resetRateLimit()
})

describe('GET /api/google/tasks', () => {
  it('401s without an app session', async () => {
    state.session = null
    expect((await GET(getReq())).status).toBe(401)
  })

  it('401s { reauth: true } when the Google token is dead', async () => {
    state.token = { accessToken: 'x', error: 'RefreshAccessTokenError' }
    const res = await GET(getReq())
    expect(res.status).toBe(401)
    expect((await res.json()).reauth).toBe(true)
  })

  it('lists task lists when no taskListId is given', async () => {
    state.google.listTaskLists.mockResolvedValue([{ id: 'l1', title: 'Ops' }])
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    expect((await res.json()).taskLists).toEqual([{ id: 'l1', title: 'Ops' }])
    expect(state.google.listTaskLists).toHaveBeenCalledWith('goog-token')
  })

  it('lists tasks in a list, forwarding showCompleted and a clamped maxResults', async () => {
    state.google.listTasks.mockResolvedValue([{ id: 't1' }])
    const res = await GET(getReq('?taskListId=l1&showCompleted=true&maxResults=500'))
    expect(res.status).toBe(200)
    expect((await res.json()).tasks).toEqual([{ id: 't1' }])
    expect(state.google.listTasks).toHaveBeenCalledWith('goog-token', 'l1', {
      showCompleted: true,
      maxResults: 100, // clamped into 1..100
    })
  })

  it('maps an upstream auth failure to 401 { reauth: true }', async () => {
    state.google.listTaskLists.mockRejectedValue(new Error('Google API error 403: forbidden'))
    const res = await GET(getReq())
    expect(res.status).toBe(401)
    expect((await res.json()).reauth).toBe(true)
  })
})

describe('POST /api/google/tasks — dispatch + validation', () => {
  it('400s on invalid JSON', async () => {
    expect((await POST(postReq('{oops'))).status).toBe(400)
  })

  it('400s when taskListId is missing', async () => {
    const res = await POST(postReq({ action: 'create', title: 'x' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('taskListId is required')
  })

  it('400s a create with an empty title (zod bounds)', async () => {
    const res = await POST(postReq({ action: 'create', taskListId: 'l1', title: '  ' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Validation failed')
    expect(state.google.createTask).not.toHaveBeenCalled()
  })

  it('creates a task (manual — no audit row) and returns it', async () => {
    state.google.createTask.mockResolvedValue({ id: 'new-task', title: 'Call vendor' })
    const res = await POST(postReq({ action: 'create', taskListId: 'l1', title: 'Call vendor', notes: 'n' }))
    expect(res.status).toBe(200)
    expect((await res.json()).task.id).toBe('new-task')
    expect(state.google.createTask).toHaveBeenCalledWith('goog-token', 'l1', {
      title: 'Call vendor', notes: 'n',
    })
    expect(state.auditRows).toHaveLength(0)
  })

  it('400s complete/uncomplete without a taskId', async () => {
    for (const action of ['complete', 'uncomplete']) {
      const res = await POST(postReq({ action, taskListId: 'l1' }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('taskId is required')
    }
  })

  it('completes and uncompletes a task through the right adapter calls', async () => {
    state.google.completeTask.mockResolvedValue({ id: 't1', status: 'completed' })
    state.google.uncompleteTask.mockResolvedValue({ id: 't1', status: 'needsAction' })
    const done = await POST(postReq({ action: 'complete', taskListId: 'l1', taskId: 't1' }))
    expect(done.status).toBe(200)
    expect(state.google.completeTask).toHaveBeenCalledWith('goog-token', 'l1', 't1')
    const undone = await POST(postReq({ action: 'uncomplete', taskListId: 'l1', taskId: 't1' }))
    expect(undone.status).toBe(200)
    expect(state.google.uncompleteTask).toHaveBeenCalledWith('goog-token', 'l1', 't1')
  })

  it('400s an unknown action', async () => {
    const res = await POST(postReq({ action: 'destroy', taskListId: 'l1' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Unknown action: destroy')
  })

  it('maps an upstream 429 on complete to a 502 (transient)', async () => {
    state.google.completeTask.mockRejectedValue(new Error('Google API error 429: quota'))
    const res = await POST(postReq({ action: 'complete', taskListId: 'l1', taskId: 't1' }))
    expect(res.status).toBe(502)
  })
})

describe('POST /api/google/tasks — AI audit + rate limit (NS-2)', () => {
  const aiHeaders = { 'x-ai-intent': 'create_task' }
  const createBody = { action: 'create', taskListId: 'l1', title: 'Secret title', notes: 'private' }

  it('audits an AI create success with routing metadata only (taskListId + created taskId, never title/notes)', async () => {
    state.google.createTask.mockResolvedValue({ id: 'task-9' })
    const res = await POST(postReq(createBody, aiHeaders))
    expect(res.status).toBe(200)
    expect(state.auditRows).toHaveLength(1)
    expect(state.auditRows[0]).toMatchObject({
      actor: 'ai',
      actionType: 'task_create',
      status: 'success',
      target: { taskListId: 'l1', taskId: 'task-9' },
    })
    expect(JSON.stringify(state.auditRows[0].target)).not.toContain('Secret title')
    expect(JSON.stringify(state.auditRows[0].target)).not.toContain('private')
  })

  it('audits an AI create failure with the error and maps the upstream status', async () => {
    state.google.createTask.mockRejectedValue(new Error('Google API error 500: boom'))
    const res = await POST(postReq(createBody, aiHeaders))
    expect(res.status).toBe(502)
    expect(state.auditRows).toHaveLength(1)
    expect(state.auditRows[0].status).toBe('failed')
    expect(String(state.auditRows[0].error)).toContain('500')
  })

  it('429s + audits rate_limited once the real task_create window is breached; manual creates are exempt', async () => {
    state.google.createTask.mockResolvedValue({ id: 't' })
    const limit = ACTION_LIMITS.task_create // 10
    for (let i = 0; i < limit; i++) {
      expect((await POST(postReq(createBody, aiHeaders))).status).toBe(200)
    }
    const breached = await POST(postReq(createBody, aiHeaders))
    expect(breached.status).toBe(429)
    expect(Number(breached.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(state.auditRows[limit]).toMatchObject({ status: 'failed', error: 'rate_limited' })
    expect(state.google.createTask).toHaveBeenCalledTimes(limit) // breach never reached Google

    // A manual create right after the AI breach still goes through untouched.
    const manual = await POST(postReq(createBody))
    expect(manual.status).toBe(200)
  })
})
