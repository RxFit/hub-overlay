import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/agents/memory — role gate (P1/P2).

   Agent memory is the fleet's shared knowledge. Previously the route gated only
   on `session?.user`, so ANY authenticated user (incl. `onboarding`) could read
   ALL tenant memory (GET) and POST arbitrary content for any agentId
   (memory-poisoning). The fix requires `staff` or above on BOTH verbs.

   These exercise the guard branches (401 / 403 / staff-pass) before/at the DB
   boundary; the agent-memory lib is mocked so a staff-authorized call reaches
   the handler without a live Postgres.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({ state: { session: null as unknown } }))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('@/lib/event-logger', () => ({ recordEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/agent-memory', () => ({
  queryMemories: vi.fn(async () => []),
  storeMemory: vi.fn(async () => [{ id: 'm1' }]),
}))

import { GET, POST } from '@/app/api/agents/memory/route'
import { queryMemories, storeMemory } from '@/lib/agent-memory'

function sess(role?: string) {
  return role ? { user: { email: 'u@example.com', role } } : null
}
function getReq() {
  return new NextRequest('http://localhost/api/agents/memory')
}
function postReq(body: unknown) {
  return new NextRequest('http://localhost/api/agents/memory', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
const VALID_MEM = { agentId: 'a1', memoryType: 'insight', content: 'a useful insight' }

beforeEach(() => {
  state.session = null
  vi.mocked(queryMemories).mockClear()
  vi.mocked(storeMemory).mockClear()
})

describe('GET /api/agents/memory — role gate', () => {
  it('401s when unauthenticated', async () => {
    state.session = null
    expect((await GET(getReq())).status).toBe(401)
    expect(queryMemories).not.toHaveBeenCalled()
  })

  it('403s onboarding (cannot read agent memory) — never reaches the query', async () => {
    state.session = sess('onboarding')
    const res = await GET(getReq())
    expect(res.status).toBe(403)
    expect(queryMemories).not.toHaveBeenCalled()
  })

  it('403s an unknown/sub-staff role (fail closed)', async () => {
    state.session = sess('guest')
    expect((await GET(getReq())).status).toBe(403)
    expect(queryMemories).not.toHaveBeenCalled()
  })

  it('allows staff and reaches the query', async () => {
    state.session = sess('staff')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    expect(queryMemories).toHaveBeenCalledTimes(1)
  })

  it('allows admin and superadmin', async () => {
    state.session = sess('admin')
    expect((await GET(getReq())).status).toBe(200)
    state.session = sess('superadmin')
    expect((await GET(getReq())).status).toBe(200)
  })
})

describe('POST /api/agents/memory — role gate (memory-poisoning defense)', () => {
  it('401s when unauthenticated', async () => {
    state.session = null
    expect((await POST(postReq(VALID_MEM))).status).toBe(401)
    expect(storeMemory).not.toHaveBeenCalled()
  })

  it('403s onboarding — cannot poison agent memory', async () => {
    state.session = sess('onboarding')
    const res = await POST(postReq(VALID_MEM))
    expect(res.status).toBe(403)
    expect(storeMemory).not.toHaveBeenCalled()
  })

  it('allows staff to store a memory (reaches storeMemory)', async () => {
    state.session = sess('staff')
    const res = await POST(postReq(VALID_MEM))
    expect(res.status).toBe(200)
    expect(storeMemory).toHaveBeenCalledTimes(1)
  })
})
