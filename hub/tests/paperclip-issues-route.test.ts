import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * P1-6b — server-side assigneeId validation on POST /api/paperclip/issues.
 *
 * An explicit assigneeId must belong to the target company's agents, otherwise
 * a caller could assign an issue to any arbitrary agent id in another
 * workspace. A non-member id is rejected with 400; a valid member passes.
 */

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({
    user: { email: 'danny@rxfitatx.com', role: 'superadmin', assignedProjects: ['*'] },
  })),
}))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('@/lib/event-logger', () => ({ recordEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/gateToken', () => ({ verifyGateToken: () => ({ valid: true }) }))
// Keep the real isAgentMemberOfCompany; stub only the network-backed helpers.
vi.mock('@/lib/paperclip', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/paperclip')>()
  return { ...actual, getAgents: vi.fn(), createIssue: vi.fn() }
})

import { POST } from '@/app/api/paperclip/issues/route'
import { getAgents, createIssue } from '@/lib/paperclip'
import { NextRequest } from 'next/server'
import type { Agent } from '@/types'

const companyAgents = [
  { id: 'agent-1', name: 'CEO' },
  { id: 'agent-2', name: 'Engineer' },
] as unknown as Agent[]

function postWith(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/paperclip/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-gate-token': 'ok' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.mocked(getAgents).mockReset().mockResolvedValue(companyAgents)
  vi.mocked(createIssue).mockReset().mockResolvedValue({
    id: 'i1',
    title: 'Test',
    identifier: 'T-1',
  } as unknown as Awaited<ReturnType<typeof createIssue>>)
})

describe('POST /api/paperclip/issues — P1-6b assigneeId membership', () => {
  it('rejects an assigneeId that is not a member of the target company (400)', async () => {
    const res = await POST(postWith({ title: 'Test', companyId: 'co-1', assigneeId: 'agent-bad' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('assigneeId does not belong to the target company')
    expect(createIssue).not.toHaveBeenCalled()
  })

  it('accepts an assigneeId that is a company agent', async () => {
    const res = await POST(postWith({ title: 'Test', companyId: 'co-1', assigneeId: 'agent-1' }))
    expect(res.status).toBe(200)
    expect(createIssue).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createIssue).mock.calls[0][1].assigneeId).toBe('agent-1')
  })

  it('still resolves the CEO server-side when no assigneeId is provided', async () => {
    const res = await POST(postWith({ title: 'Test', companyId: 'co-1' }))
    expect(res.status).toBe(200)
    expect(createIssue).toHaveBeenCalledTimes(1)
    // CEO resolution picks the agent whose name contains "ceo".
    expect(vi.mocked(createIssue).mock.calls[0][1].assigneeId).toBe('agent-1')
  })
})
