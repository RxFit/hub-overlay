import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   The second coverage slice: the routes whose catch blocks existed only to
   turn any failure into a generic 500 (ERROR_REPORTING_2026-08-24.md §3
   Layer 3).

   tests/route-fault-coverage.test.ts proves the wrapper is ATTACHED. This file
   proves the three things the sweep actually changed, on real routes:

     1. the response is now a fault response — problem+json, a HUB- id, a
        reported fault — where it used to be a hand-rolled body with nothing
        recorded anywhere;
     2. the RAW UPSTREAM MESSAGE no longer reaches the client. Several of these
        routes shipped `error.message` verbatim (the auditor trio even put it in
        a `details` field unconditionally, production included). That is the leak
        class §1 names, and deleting the catch is what closes it;
     3. the catches that were NOT generic survived intact — the 502 on
        paperclip/runs, and the issue.creation_failed ledger write that has to
        happen before the error leaves.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: { session: { user: { email: 'danny@rxfitatx.com', role: 'superadmin', assignedProjects: ['*'] } } as unknown },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

const { discover } = vi.hoisted(() => ({ discover: vi.fn() }))
vi.mock('@/lib/auditor/discovery', () => ({ discoverApplicationFootprint: discover }))

const { getRuns, getAgents, createIssue } = vi.hoisted(() => ({
  getRuns: vi.fn(), getAgents: vi.fn(), createIssue: vi.fn(),
}))
vi.mock('@/lib/paperclip', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/paperclip')>()),
  getRuns, getAgents, createIssue,
}))

const { recordEvent } = vi.hoisted(() => ({
  recordEvent: vi.fn(async (_event: { eventType: string }) => {}),
}))
vi.mock('@/lib/event-logger', () => ({ recordEvent, recordEventStrict: vi.fn(async () => {}) }))
vi.mock('@/lib/gateToken', () => ({ verifyGateToken: () => ({ valid: true }) }))

import { POST as auditorDiscover } from '@/app/api/auditor/discover/route'
import { GET as paperclipRuns } from '@/app/api/paperclip/runs/route'
import { POST as createIssueRoute } from '@/app/api/paperclip/issues/route'
import { _resetFaultReportStateForTests, getFaultReportCounters } from '@/lib/fault-report'

const FAULT_ID = /^HUB-[A-Z2-7]{8}$/
const SECRET = 'postgres://hub:hunter2@10.0.0.5:5432/hub'

beforeEach(() => {
  state.session = { user: { email: 'danny@rxfitatx.com', role: 'superadmin', assignedProjects: ['*'] } }
  vi.clearAllMocks()
  _resetFaultReportStateForTests()
})

afterEach(() => vi.clearAllMocks())

describe('sweep 2b — a generic failure becomes a fault response, not a hand-rolled 500', () => {
  it('auditor/discover answers problem+json with a fault id and reports the fault', async () => {
    discover.mockImplementation(() => { throw new Error(`scan failed reading ${SECRET}`) })

    const res = await auditorDiscover(new NextRequest('http://localhost/api/auditor/discover', { method: 'POST' }))

    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    expect(res.headers.get('x-hub-fault-id')).toMatch(FAULT_ID)
    expect(getFaultReportCounters().reported).toBe(1)
  })

  it('and the raw upstream message no longer reaches the client', async () => {
    discover.mockImplementation(() => { throw new Error(`scan failed reading ${SECRET}`) })

    const res = await auditorDiscover(new NextRequest('http://localhost/api/auditor/discover', { method: 'POST' }))
    const raw = JSON.stringify(await res.json())

    // This route used to return `details: error.message` UNCONDITIONALLY —
    // production included — so the connection string went straight to the
    // browser. The fixed per-code message is all the client gets now.
    expect(raw).not.toContain('hunter2')
    expect(raw).not.toContain('10.0.0.5')
  })
})

describe('sweep 2b — the catches that were not generic survived', () => {
  it('paperclip/runs still answers 502, because the code says so', async () => {
    getRuns.mockRejectedValue(new Error('paperclip aggregation blew up'))

    const res = await paperclipRuns(
      new NextRequest('http://localhost/api/paperclip/runs?companyId=c1'),
    )

    // A bare `throw` would have flattened this to 500. The AppError names
    // upstream_5xx, and statusForCode maps that back to 502.
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.code).toBe('upstream_5xx')
    expect(body.instance).toMatch(FAULT_ID)
  })

  it('paperclip/issues POST writes the failure ledger entry before the error leaves', async () => {
    getAgents.mockResolvedValue([{ id: 'agent-1', name: 'CEO' }])
    createIssue.mockRejectedValue(new Error('paperclip write rejected'))

    const res = await createIssueRoute(
      new NextRequest('http://localhost/api/paperclip/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-gate-token': 'ok' },
        body: JSON.stringify({ title: 'a title', description: 'a description', companyId: 'c1' }),
      }),
    )

    expect(res.status).toBe(500)
    // The audit trail for a write that did not happen is the whole reason this
    // catch still exists.
    const kinds = recordEvent.mock.calls.map(([event]) => event.eventType)
    expect(kinds).toContain('issue.creation_failed')
  })
})
