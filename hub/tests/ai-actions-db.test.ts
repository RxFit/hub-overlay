import { it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import {
  describeDb,
  migrateTestDb,
  resetDb,
  seedAiAction,
  getSql,
  closeDb,
} from '../test/db-harness'

/* ════════════════════════════════════════════════════════════════════════════
   DB-BACKED /api/ai-actions (NS-8).

   tests/ai-actions-route.test.ts (NS-2) mocks listAiActions and can only
   assert the route's guards. THIS suite goes end-to-end: real rows in a real
   `ai_action_log` table, exercising lib/ai-audit's recordAiAction (the insert
   + redaction path) and listAiActions (the read/mapping path) through the
   actual route handler.

   Gated with describeDb — skips locally without DATABASE_URL, runs in CI.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({ state: { session: null as unknown } }))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => state.session),
}))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))

import { GET } from '@/app/api/ai-actions/route'
import { recordAiAction } from '@/lib/ai-audit'

const SELF = 'danny@rxfitatx.com'
const OTHER = 'staffer@rxfitatx.com'

function req(qs = '') {
  return new NextRequest(`http://localhost/api/ai-actions${qs}`)
}

function at(minutesAgo: number): Date {
  return new Date(Date.now() - minutesAgo * 60_000)
}

describeDb('GET /api/ai-actions — DB-backed', () => {
  beforeAll(() => {
    migrateTestDb()
  })

  beforeEach(async () => {
    await resetDb()
    state.session = { user: { email: SELF, role: 'staff' } }
  })

  afterAll(async () => {
    await closeDb()
  })

  it('returns only the CALLER’S rows, newest first', async () => {
    await seedAiAction({ userEmail: SELF, actionType: 'gmail_send', createdAt: at(30) })
    await seedAiAction({ userEmail: SELF, actionType: 'chat_post', createdAt: at(10) })
    await seedAiAction({ userEmail: OTHER, actionType: 'task_create', createdAt: at(5) })

    const res = await GET(req())
    expect(res.status).toBe(200)
    const { actions } = await res.json()

    expect(actions).toHaveLength(2)
    expect(actions.map((a: { actionType: string }) => a.actionType)).toEqual([
      'chat_post',
      'gmail_send',
    ])
    expect(actions.every((a: { userEmail: string }) => a.userEmail === SELF)).toBe(true)
  })

  it('matches the caller case-insensitively (emails are stored normalized)', async () => {
    await seedAiAction({ userEmail: SELF, createdAt: at(1) })
    state.session = { user: { email: 'Danny@RxFitATX.com', role: 'staff' } }

    const res = await GET(req())
    const { actions } = await res.json()
    expect(actions).toHaveLength(1)
  })

  it('clamps ?limit to the requested window against real rows', async () => {
    for (let i = 0; i < 5; i++) {
      await seedAiAction({ userEmail: SELF, requestId: `r${i}`, createdAt: at(60 - i) })
    }

    // limit=2 → the two NEWEST rows
    const limited = await (await GET(req('?limit=2'))).json()
    expect(limited.actions.map((a: { requestId: string }) => a.requestId)).toEqual(['r4', 'r3'])

    // limit=0 clamps up to 1; garbage clamps to the default (all 5 here)
    const zero = await (await GET(req('?limit=0'))).json()
    expect(zero.actions).toHaveLength(1)
    const garbage = await (await GET(req('?limit=banana'))).json()
    expect(garbage.actions).toHaveLength(5)
  })

  it('rejects a non-admin reading another user’s trail with 403 — and leaks nothing', async () => {
    await seedAiAction({ userEmail: OTHER, createdAt: at(1) })

    const res = await GET(req(`?user=${OTHER}`))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.actions).toBeUndefined()
  })

  it('lets an admin read another user’s trail', async () => {
    await seedAiAction({ userEmail: OTHER, actionType: 'chat_post', createdAt: at(1) })
    state.session = { user: { email: SELF, role: 'admin' } }

    const res = await GET(req(`?user=${OTHER.toUpperCase()}`))
    expect(res.status).toBe(200)
    const { actions } = await res.json()
    expect(actions).toHaveLength(1)
    expect(actions[0].userEmail).toBe(OTHER)
    expect(actions[0].actionType).toBe('chat_post')
  })

  it('recordAiAction → GET round-trip: content is REDACTED, token fingerprinted', async () => {
    await recordAiAction({
      userEmail: SELF,
      actionType: 'gmail_send',
      target: {
        to: 'client@example.com',
        subject: 'SECRET SUBJECT', // body-like — must be stripped
        body: 'SECRET BODY', // body-like — must be stripped
        threadId: 'th-1',
      },
      intent: 'send_email',
      gateToken: 'full-gate-token-value',
      requestId: 'req-42',
      status: 'success',
    })

    const res = await GET(req())
    const { actions } = await res.json()
    expect(actions).toHaveLength(1)

    const row = actions[0]
    expect(row.target).toEqual({ to: 'client@example.com', threadId: 'th-1' })
    expect(JSON.stringify(row)).not.toContain('SECRET')
    expect(JSON.stringify(row)).not.toContain('full-gate-token-value')
    expect(row.gateTokenId).toMatch(/^[0-9a-f]{16}$/)
    expect(row.intent).toBe('send_email')
    expect(row.requestId).toBe('req-42')
    expect(row.status).toBe('success')
    expect(typeof row.createdAt).toBe('string')
    expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false)

    // And the DB row itself holds no secret either (defense in depth).
    const [dbRow] = await getSql()<{ target: Record<string, unknown> | null }[]>`
      SELECT target FROM ai_action_log WHERE request_id = 'req-42'
    `
    expect(JSON.stringify(dbRow.target)).not.toContain('SECRET')
  })

  it('records FAILED actions with their error reason', async () => {
    await recordAiAction({
      userEmail: SELF,
      actionType: 'chat_post',
      status: 'failed',
      error: 'rate_limited',
    })

    const { actions } = await (await GET(req())).json()
    expect(actions).toHaveLength(1)
    expect(actions[0].status).toBe('failed')
    expect(actions[0].error).toBe('rate_limited')
  })
})
