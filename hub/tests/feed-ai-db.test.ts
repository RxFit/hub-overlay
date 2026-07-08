import { it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  describeDb,
  migrateTestDb,
  resetDb,
  seedAiAction,
  closeDb,
} from '../test/db-harness'

/* ════════════════════════════════════════════════════════════════════════════
   DB-BACKED GET /api/feed — AI-action provenance merge (NS-9).

   Real rows in a real `ai_action_log` table flow through listAiActions →
   aiActionToFeedItem → the feed route, merged with (mocked) Paperclip items.
   Asserts: merge + timestamp-desc ordering, failure → needs_you, DB-error
   degradation to a Paperclip-only feed, and the onboarding early-return.

   Gated with describeDb — skips locally without DATABASE_URL, runs in CI.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    aiDbDown: false,
    issues: [] as unknown[],
  },
}))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => state.session),
}))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))

// Paperclip is not under test here — pin it to a deterministic single-company
// world so the DB-backed AI rows are the only variable.
vi.mock('@/lib/paperclip', () => ({
  getCompanies: vi.fn(async () => [{ id: 'c1', name: 'Acme' }]),
  getIssues: vi.fn(async () => state.issues),
  getAgents: vi.fn(async () => []),
}))

// Pass listAiActions through to the REAL implementation, with a kill switch to
// simulate the audit DB being down for the degradation test.
vi.mock('@/lib/ai-audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-audit')>()
  return {
    ...actual,
    listAiActions: vi.fn(async (opts: { userEmail: string; limit: number }) => {
      if (state.aiDbDown) throw new Error('audit db down')
      return actual.listAiActions(opts)
    }),
  }
})

import { GET } from '@/app/api/feed/route'

const SELF = 'danny@rxfitatx.com'
const OTHER = 'staffer@rxfitatx.com'

function at(minutesAgo: number): Date {
  return new Date(Date.now() - minutesAgo * 60_000)
}

function issueAt(minutesAgo: number) {
  return {
    id: 'i1',
    identifier: 'ACM-1',
    title: 'Fix the door',
    state: { group: 'started', name: 'In Progress' },
    priority: 'medium',
    updatedAt: at(minutesAgo).toISOString(),
  }
}

describeDb('GET /api/feed — AI-action provenance (DB-backed)', () => {
  beforeAll(() => {
    migrateTestDb()
  })

  beforeEach(async () => {
    await resetDb()
    state.session = {
      user: { email: SELF, role: 'staff', assignedProjects: ['c1'] },
    }
    state.aiDbDown = false
    state.issues = [issueAt(20)]
  })

  afterAll(async () => {
    await closeDb()
  })

  it('merges the caller’s seeded AI rows with Paperclip items, timestamp-desc', async () => {
    await seedAiAction({
      userEmail: SELF,
      actionType: 'gmail_send',
      target: { to: 'client@example.com' },
      intent: 'send_email',
      requestId: 'req-ok',
      createdAt: at(10),
    })
    await seedAiAction({
      userEmail: SELF,
      actionType: 'chat_post',
      target: { space: 'spaces/ops' },
      status: 'failed',
      error: 'rate_limited',
      requestId: 'req-bad',
      createdAt: at(5),
    })
    // Another user's action must NOT appear — the feed is caller-scoped.
    await seedAiAction({ userEmail: OTHER, createdAt: at(1) })

    const res = await GET()
    expect(res.status).toBe(200)
    const { feed } = await res.json()

    expect(feed.map((f: { id: string }) => f.id)).toEqual([
      expect.stringMatching(/^ai-/), // 5 min ago — failed chat_post
      expect.stringMatching(/^ai-/), // 10 min ago — gmail_send
      'issue-i1', // 20 min ago — Paperclip
    ])

    const [failedPost, sentEmail] = feed
    expect(failedPost.source).toBe('ai_action')
    expect(failedPost.type).toBe('needs_you')
    expect(failedPost.title).toBe('AI post in spaces/ops failed')
    expect(failedPost.description).toBe('Failed — rate_limited')
    expect(failedPost.metadata).toEqual({
      actionType: 'chat_post',
      status: 'failed',
      requestId: 'req-bad',
    })

    expect(sentEmail.type).toBe('completed')
    expect(sentEmail.title).toBe('AI sent an email to client@example.com')
    expect(sentEmail.description).toBe('send_email · Completed successfully')
  })

  it('matches the session email case-insensitively (like /api/ai-actions)', async () => {
    await seedAiAction({ userEmail: SELF, createdAt: at(1) })
    state.session = {
      user: { email: 'Danny@RxFitATX.com', role: 'staff', assignedProjects: ['c1'] },
    }

    const { feed } = await (await GET()).json()
    expect(feed.filter((f: { source: string }) => f.source === 'ai_action')).toHaveLength(1)
  })

  it('degrades to a Paperclip-only feed when the audit DB is down (no 500)', async () => {
    await seedAiAction({ userEmail: SELF, createdAt: at(1) })
    state.aiDbDown = true

    const res = await GET()
    expect(res.status).toBe(200)
    const { feed } = await res.json()

    expect(feed).toHaveLength(1)
    expect(feed[0].id).toBe('issue-i1')
    expect(feed.some((f: { source: string }) => f.source === 'ai_action')).toBe(false)
  })

  it('onboarding users still get an empty feed even with seeded AI rows', async () => {
    await seedAiAction({ userEmail: SELF, createdAt: at(1) })
    state.session = { user: { email: SELF, role: 'onboarding' } }

    const res = await GET()
    expect(res.status).toBe(200)
    const { feed } = await res.json()
    expect(feed).toEqual([])
  })
})
