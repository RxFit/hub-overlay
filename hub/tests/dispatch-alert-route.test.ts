import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * /api/cron/dispatch-alert — route contract.
 *
 * /api/cron is middleware-excluded (a scheduler cannot hold a NextAuth
 * cookie), so this handler's constant-time CRON_SECRET check is the ONLY
 * gate — locked here exactly like worker-routes.test.ts locks the
 * x-worker-secret routes. 503-when-unset doubles as the kill switch.
 */

const tickMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/dispatch-alerts', async () => ({
  // Only the tick is mocked. normalizeDeployReport is pure and is the route's
  // actual input gate, so stubbing it would let a validation regression pass.
  ...(await vi.importActual<typeof import('@/lib/dispatch-alerts')>('@/lib/dispatch-alerts')),
  runDispatchAlertTick: tickMock,
}))

import { POST } from '@/app/api/cron/dispatch-alert/route'

const ORIGINAL_SECRET = process.env.CRON_SECRET

function request(secret?: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/dispatch-alert', {
    method: 'POST',
    ...(secret !== undefined ? { headers: { 'x-cron-secret': secret } } : {}),
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
}

/** The deploy report the tick was handed, if any. */
function reportedDeploy() {
  return tickMock.mock.calls[0]?.[2] ?? null
}

beforeEach(() => {
  tickMock.mockReset().mockResolvedValue({ alerts: [], delivery: 'none', channel: null })
  process.env.CRON_SECRET = 'shh'
})

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = ORIGINAL_SECRET
})

describe('POST /api/cron/dispatch-alert', () => {
  it('503s when CRON_SECRET is unset (kill switch), without evaluating anything', async () => {
    delete process.env.CRON_SECRET
    expect((await POST(request('shh'))).status).toBe(503)
    expect(tickMock).not.toHaveBeenCalled()
  })

  it('401s on a wrong secret without evaluating anything', async () => {
    expect((await POST(request('wrong'))).status).toBe(401)
    expect(tickMock).not.toHaveBeenCalled()
  })

  it('401s on a missing header', async () => {
    expect((await POST(request())).status).toBe(401)
  })

  it('runs the tick and echoes its result on a valid secret', async () => {
    tickMock.mockResolvedValue({
      alerts: [{ kind: 'worker_stale', detail: 'no desktop worker is fresh' }],
      delivery: 'github',
      channel: null,
    })
    const res = await POST(request('shh'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.delivery).toBe('github')
    expect(body.alerts).toHaveLength(1)
    expect(tickMock).toHaveBeenCalledOnce()
  })
})

/**
 * The deploy conclusion the hourly workflow reports.
 *
 * The rule that matters is DEGRADE, NEVER REJECT: every other condition this
 * tick evaluates has to keep working when the deploy lookup fails, so a
 * missing or malformed body is "not reported", not a 400. A 400 here would
 * take the whole alerting path down over its newest input — the detector
 * failing inside the thing it detects.
 */
describe('POST /api/cron/dispatch-alert — the reported deploy conclusion', () => {
  it('passes a well-formed report through to the tick', async () => {
    const body = { deploy: { conclusion: 'failure', consecutiveFailures: 14, sha: 'FF6E0AC047EB15F0', runNumber: 208 } }
    expect((await POST(request('shh', body))).status).toBe(200)
    expect(reportedDeploy()).toEqual({ conclusion: 'failure', consecutiveFailures: 14, sha: 'ff6e0ac047eb', runNumber: 208 })
  })

  it('still runs the tick with no body at all (the pre-report workflow shape)', async () => {
    expect((await POST(request('shh'))).status).toBe(200)
    expect(tickMock).toHaveBeenCalled()
    expect(reportedDeploy()).toBeNull()
  })

  it('degrades on an empty object, unparseable JSON, or a junk deploy field — never a 400', async () => {
    for (const body of ['{}', 'not json at all', { deploy: null }, { deploy: 'failure' }, { deploy: { conclusion: '' } }]) {
      tickMock.mockClear()
      const res = await POST(request('shh', body))
      expect(res.status).toBe(200)
      expect(tickMock).toHaveBeenCalled()
      expect(reportedDeploy()).toBeNull()
    }
  })

  it('a hostile report is clamped before it can reach a Chat message', async () => {
    const body = { deploy: { conclusion: '<img src=x>failure', consecutiveFailures: -1, sha: 'rm -rf /', runNumber: -3 } }
    expect((await POST(request('shh', body))).status).toBe(200)
    const d = reportedDeploy()
    expect(d.conclusion).toMatch(/^[a-z_]+$/)
    expect(d.consecutiveFailures).toBe(0)
    expect(d.sha).toBeNull()
    expect(d.runNumber).toBeNull()
  })

  it('an unauthenticated caller never reaches the report path', async () => {
    const body = { deploy: { conclusion: 'failure', consecutiveFailures: 1, sha: null, runNumber: 1 } }
    expect((await POST(request('wrong', body))).status).toBe(401)
    expect(tickMock).not.toHaveBeenCalled()
  })
})
