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
vi.mock('@/lib/dispatch-alerts', () => ({ runDispatchAlertTick: tickMock }))

import { POST } from '@/app/api/cron/dispatch-alert/route'

const ORIGINAL_SECRET = process.env.CRON_SECRET

function request(secret?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/dispatch-alert', {
    method: 'POST',
    ...(secret !== undefined ? { headers: { 'x-cron-secret': secret } } : {}),
  })
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
