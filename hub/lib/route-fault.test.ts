import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { withFault, isFaultWrapped, safeRequestId, isNextControlFlow, detectErrorIn2xx } from './route-fault'
import { AppError } from './errors'

// The reporter is mocked file-wide so every test can assert on (and sabotage)
// it. toFault is wrapped so ONE test can make the normalizer itself explode.
vi.mock('./fault-report', () => ({ reportFault: vi.fn() }))
vi.mock('./fault', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fault')>()
  return { ...actual, toFault: vi.fn(actual.toFault) }
})
import { reportFault } from './fault-report'
import { toFault } from './fault'
const reportMock = vi.mocked(reportFault)
const toFaultMock = vi.mocked(toFault)

/* ════════════════════════════════════════════════════════════════════════════
   withFault (lib/route-fault.ts) — the wrapper that ships to every route.
   The load-bearing suite: the reporter can NEVER break a request, Next
   control flow re-throws, streaming bodies pass through untouched, and the
   correlation id cannot be poisoned. This is what licenses applying one
   wrapper to 112 handlers.
   ════════════════════════════════════════════════════════════════════════════ */

const UUID = '123e4567-e89b-42d3-a456-426614174000'

function req(headers: Record<string, string> = {}, method = 'GET'): NextRequest {
  return new NextRequest('http://localhost/api/probe', { method, headers })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the correlation spine', () => {
  it('honors a well-formed header UUID and echoes it on the response', async () => {
    const handler = withFault('probe', async () => NextResponse.json({ ok: true }))
    const res = await handler(req({ 'x-hub-request-id': UUID }))
    expect(res.headers.get('x-hub-request-id')).toBe(UUID)
  })

  it('REJECTS a poisoned header and mints fresh — never copies attacker text into logs', async () => {
    const handler = withFault('probe', async () => NextResponse.json({ ok: true }))
    const hostile = 'DROP TABLE users;--'
    const res = await handler(req({ 'x-hub-request-id': hostile }))
    const echoed = res.headers.get('x-hub-request-id')
    expect(echoed).not.toBe(hostile)
    expect(echoed).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('safeRequestId: only an exact UUID passes', () => {
    expect(safeRequestId(UUID)).toBe(UUID)
    expect(safeRequestId(UUID.toUpperCase())).toBe(UUID)
    expect(safeRequestId(null)).toMatch(/^[0-9a-f-]{36}$/)
    expect(safeRequestId(`${UUID}x`)).not.toContain('x')
    expect(safeRequestId('x'.repeat(4000))).toHaveLength(36)
  })
})

describe('Next control flow re-throws unchanged', () => {
  it('redirect() and notFound() digests escape the wrapper', async () => {
    for (const digest of ['NEXT_REDIRECT;replace;/login;307;', 'NEXT_NOT_FOUND']) {
      const err = Object.assign(new Error(digest), { digest })
      const handler = withFault('probe', async () => {
        throw err
      })
      await expect(handler(req())).rejects.toBe(err)
    }
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('isNextControlFlow never matches an ordinary error', () => {
    expect(isNextControlFlow(new Error('NEXT_REDIRECT in a message is not a digest'))).toBe(false)
    expect(isNextControlFlow(null)).toBe(false)
  })
})

describe('a thrown error becomes one reported fault and a problem+json response', () => {
  it('maps an AppError to its status; reports exactly once; sets x-hub-fault-id', async () => {
    const handler = withFault('probe', async () => {
      throw new AppError('bad input', { code: 'validation_failed' })
    })
    const res = await handler(req({}, 'POST'))
    expect(res.status).toBe(422)
    expect(res.headers.get('x-hub-fault-id')).toMatch(/^HUB-[A-Z2-7]{8}$/)
    expect(res.headers.get('content-type')).toContain('problem+json')
    const body = await res.json()
    expect(body.code).toBe('validation_failed')
    expect(reportMock).toHaveBeenCalledTimes(1)
    expect(reportMock.mock.calls[0][0]).toMatchObject({ code: 'validation_failed', route: 'probe', method: 'POST' })
  })

  it('an unknown throw is a 500 internal with the generic client message only', async () => {
    const handler = withFault('probe', async () => {
      throw new Error('pg password=hunter2')
    })
    const res = await handler(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Something went wrong. Please try again.')
    expect(JSON.stringify(body)).not.toContain('hunter2') // details is scrubbed even outside prod
  })
})

describe('streaming responses pass through untouched', () => {
  it('returns the SAME Response object, body unread and unlocked, bytes intact', async () => {
    const original = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"delta":"hi"}\n\n'))
          c.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
    const handler = withFault('chat', async () => original)
    const res = await handler(req())
    expect(res).toBe(original) // identity — nothing wrapped or cloned
    expect(res.bodyUsed).toBe(false) // never read by the wrapper
    expect(await res.text()).toBe('data: {"delta":"hi"}\n\n')
    expect(reportMock).not.toHaveBeenCalled()
  })
})

describe('the 2xx contract check (gated, per the P0-3 correction)', () => {
  function jsonWithLength(body: unknown, status = 200): NextResponse {
    const text = JSON.stringify(body)
    return new NextResponse(text, {
      status,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) },
    })
  }

  it('a sized 2xx JSON body carrying `error` is reported as contract_violation', async () => {
    const handler = withFault('probe', async () => jsonWithLength({ companies: [], error: 'Failed to load' }))
    const res = await handler(req())
    // outside production the check fails loud
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('contract_violation')
    expect(reportMock).toHaveBeenCalledTimes(1)
    expect(reportMock.mock.calls[0][0]).toMatchObject({ code: 'contract_violation' })
  })

  it('an UNSIZED json response is never read — the gate requires content-length', async () => {
    const handler = withFault('probe', async () => NextResponse.json({ error: 'x' })) // no content-length
    const res = await handler(req())
    expect(res.status).toBe(200)
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('FALSY error keys still flag — key presence is the contract, not truthiness', async () => {
    for (const body of [{ error: '' }, { reason: null }]) {
      reportMock.mockClear()
      const handler = withFault('probe', async () => jsonWithLength(body))
      const res = await handler(req())
      expect(res.status).toBe(500)
      expect(reportMock).toHaveBeenCalledTimes(1)
    }
  })

  it('a clean sized 2xx passes; a sized 4xx with `error` passes (only 2xx is a contradiction)', async () => {
    const ok = withFault('probe', async () => jsonWithLength({ companies: [1] }))
    expect((await ok(req())).status).toBe(200)
    const notFound = withFault('probe', async () => jsonWithLength({ error: 'nope' }, 404))
    expect((await notFound(req())).status).toBe(404)
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('detectErrorIn2xx never throws on garbage', async () => {
    const res = new NextResponse('not json{', {
      headers: { 'content-type': 'application/json', 'content-length': '9' },
    })
    expect(await detectErrorIn2xx(res)).toBeNull()
  })
})

describe('THE test: the reporter can never break a request', () => {
  it('returns the handler response unchanged when every sink throws', async () => {
    reportMock.mockImplementation(() => {
      throw new Error('sink exploded')
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('stdout is gone')
    })
    try {
      const handler = withFault('probe', async () => NextResponse.json({ ok: true }))
      const res = await handler(req())
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      logSpy.mockRestore()
    }
  })

  it('still returns a well-formed 500 when toFault ITSELF throws — with a broken console too', async () => {
    toFaultMock.mockImplementationOnce(() => {
      throw new Error('normalizer exploded')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('console is gone too')
    })
    try {
      const handler = withFault('probe', async () => {
        throw new Error('boom')
      })
      const res = await handler(req({}, 'POST'))
      expect(res.status).toBe(500)
      expect(res.headers.get('x-hub-fault-id')).toMatch(/^HUB-/)
      expect(await res.json()).toMatchObject({ status: 500, code: 'internal' })
    } finally {
      errSpy.mockRestore()
    }
  })

  it('a reporting failure on the error path still yields problem+json, never a second throw', async () => {
    reportMock.mockImplementation(() => {
      throw new Error('reporter down')
    })
    const handler = withFault('probe', async () => {
      throw new AppError('x', { code: 'db_error' })
    })
    const res = await handler(req())
    expect(res.status).toBe(500)
    expect(res.headers.get('x-hub-fault-id')).toBeTruthy()
  })
})

describe('the brand', () => {
  it('wrapped handlers carry FAULT_WRAPPED; plain ones do not', () => {
    const wrapped = withFault('probe', async () => NextResponse.json({}))
    expect(isFaultWrapped(wrapped)).toBe(true)
    expect(isFaultWrapped(async () => NextResponse.json({}))).toBe(false)
    expect(wrapped.name).toBe('withFault(probe)')
  })

  it('dynamic-params handlers keep their second argument', async () => {
    const handler = withFault('deep-runs/[id]', async (_req: NextRequest, { params }: { params: { id: string } }) =>
      NextResponse.json({ id: params.id }),
    )
    const res = await handler(req(), { params: { id: 'r42' } })
    expect(await res.json()).toEqual({ id: 'r42' })
  })
})
