import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  toFault,
  faultResponse,
  newFaultId,
  flattenError,
  causeChain,
} from './fault'
import { AppError } from './errors'
import { statusForCode, classifyCode, USER_MESSAGES } from './fault-codes'

/* ════════════════════════════════════════════════════════════════════════════
   The canonical fault normalizer (lib/fault.ts) — recognition order, the
   flattenError contract, explicit cause-chain walking, the problem+json
   response, and identity format. Redaction has its own suite
   (lib/fault-redact.test.ts).
   ════════════════════════════════════════════════════════════════════════════ */

const CTX = { layer: 'route' as const, route: '/api/probe', method: 'GET', requestId: 'r1' }

describe('newFaultId', () => {
  it('mints HUB- + 8 base32 chars, unique per call', () => {
    const a = newFaultId()
    const b = newFaultId()
    expect(a).toMatch(/^HUB-[A-Z2-7]{8}$/)
    expect(b).toMatch(/^HUB-[A-Z2-7]{8}$/)
    expect(a).not.toBe(b)
  })
})

describe('flattenError', () => {
  it('single-lines, trims, and truncates at 300 with an ellipsis (the lib/runs.ts contract)', () => {
    expect(flattenError('  a\n  b\t c ')).toBe('a b c')
    expect(flattenError(null)).toBeNull()
    expect(flattenError('   ')).toBeNull()
    const long = 'x'.repeat(400)
    const flat = flattenError(long)
    expect(flat).toHaveLength(301)
    expect(flat?.endsWith('…')).toBe(true)
  })
})

describe('toFault — recognition order', () => {
  it('AppError passes through: code, retryable, userMessage and context all honored', () => {
    const err = new AppError('gmail send blew up', {
      code: 'upstream_5xx',
      context: { provider: 'gmail', attempt: 2 },
      retryable: false,
    })
    const fault = toFault(err, CTX)
    expect(fault.code).toBe('upstream_5xx')
    expect(fault.isRetryable).toBe(false) // explicit override beats the default (true)
    expect(fault.userMessage).toBe(USER_MESSAGES.upstream_5xx)
    expect(fault.context).toMatchObject({ provider: 'gmail', attempt: 2 })
    expect(fault.httpStatus).toBe(502)
    expect(fault.blame).toBe('upstream')
  })

  it('AppError keeps the ES2022 cause chain and the trace starts at the throw site', () => {
    const root = new Error('socket hang up')
    const err = new AppError('wrapper', { code: 'upstream_unavailable', cause: root })
    expect(err.cause).toBe(root)
    expect(err.stack).not.toContain('at new AppError')
    expect(err).toBeInstanceOf(AppError)
    expect(err).toBeInstanceOf(Error)
  })

  it('ZodError is recognized STRUCTURALLY and keeps paths only — never input values', () => {
    const schema = z.object({ body: z.object({ email: z.string().email() }) })
    const parsed = schema.safeParse({ body: { email: 'secret-not-an-email' } })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const fault = toFault(parsed.error, CTX)
    expect(fault.code).toBe('validation_failed')
    expect(fault.severity).toBe('expected')
    expect(fault.httpStatus).toBe(422)
    expect(fault.issues?.[0].path).toBe('body.email')
    expect(JSON.stringify(fault.issues)).not.toContain('secret-not-an-email')
  })

  it('AbortError is a cancellation, not an error', () => {
    const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    const fault = toFault(err, CTX)
    expect(fault.outcome).toBe('cancelled')
    expect(fault.severity).toBe('expected')
    expect(fault.blame).toBe('cancelled')
    expect(fault.isExpected).toBe(true)
  })

  it('the existing ad-hoc classes are recognized by NAME (retrofit is Phase 2)', () => {
    const circuit = Object.assign(new Error('Circuit open for gmail'), { name: 'CircuitOpenError' })
    expect(toFault(circuit, CTX).code).toBe('upstream_breaker_open')
    expect(toFault(circuit, CTX).isRetryable).toBe(false) // did not try, by policy

    const pageToken = Object.assign(new Error('bad token'), { name: 'InvalidPageTokenError' })
    expect(toFault(pageToken, CTX).code).toBe('validation_failed')
  })

  it('Postgres SQLSTATEs map by class: 42P01 → db_table_missing (fatal), 23505 → db_constraint', () => {
    const missing = Object.assign(new Error('relation "faults" does not exist'), { code: '42P01' })
    const missingFault = toFault(missing, CTX)
    expect(missingFault.code).toBe('db_table_missing')
    expect(missingFault.severity).toBe('fatal')

    const dupe = Object.assign(new Error('duplicate key value'), { code: '23505' })
    expect(toFault(dupe, CTX).code).toBe('db_constraint')
  })

  it('a SQLSTATE hiding in err.cause is still found (fetch failed → ECONNREFUSED)', () => {
    const err = new Error('fetch failed')
    ;(err as Error & { cause: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    })
    expect(toFault(err, CTX).code).toBe('upstream_unavailable')
  })

  it('anything unrecognized is `internal` — the system was surprised', () => {
    const fault = toFault(new Error('undefined is not a function'), CTX)
    expect(fault.code).toBe('internal')
    expect(fault.severity).toBe('error')
    expect(fault.isExpected).toBe(false)
    expect(fault.httpStatus).toBe(500)
  })

  it('a non-Error throw still normalizes', () => {
    const fault = toFault('plain string thrown', CTX)
    expect(fault.code).toBe('internal')
    expect(fault.message).toContain('plain string thrown')
    expect(fault.errName).toBeNull()
  })

  it('the ctx code override wins over recognition — the boundary knows best', () => {
    const err = new Error('anything')
    const fault = toFault(err, { ...CTX, code: 'google_api_not_enabled' })
    expect(fault.code).toBe('google_api_not_enabled')
    expect(fault.httpStatus).toBe(403)
  })
})

describe('causeChain', () => {
  it('walks a 3-deep chain explicitly and stops at depth 3', () => {
    const d4 = new Error('level four')
    const d3 = new Error('level three', { cause: d4 })
    const d2 = new Error('level two', { cause: d3 })
    const d1 = new Error('level one', { cause: d2 })
    const chain = causeChain(d1)
    expect(chain).toHaveLength(3)
    expect(chain.map((c) => c.message)).toEqual(['level two', 'level three', 'level four'])
  })

  it('survives a non-Error cause', () => {
    const err = new Error('top', { cause: 'just a string' })
    expect(causeChain(err)).toEqual([{ name: 'NonError', message: 'just a string' }])
  })
})

describe('faultResponse — the problem+json contract', () => {
  it('production: generic detail, faultId headers, NO internal message', async () => {
    const fault = toFault(new Error('pg password=hunter2 rejected'), CTX)
    const res = faultResponse(fault, true)
    expect(res.status).toBe(500)
    expect(res.headers.get('x-hub-fault-id')).toMatch(/^HUB-/)
    expect(res.headers.get('x-hub-request-id')).toBe('r1')
    expect(res.headers.get('content-type')).toContain('problem+json')
    const body = await res.json()
    expect(body.instance).toBe(fault.faultId)
    expect(body.code).toBe('internal')
    expect(body.error).toBe(USER_MESSAGES.internal) // back-compat envelope key
    expect(JSON.stringify(body)).not.toContain('hunter2')
    expect(body.details).toBeUndefined()
  })

  it('development: details carries the operator message', async () => {
    const fault = toFault(new Error('boom boom'), CTX)
    const body = await faultResponse(fault, false).json()
    expect(body.details).toContain('boom boom')
  })

  it('validation faults expose issue PATHS in the body', async () => {
    const parsed = z.object({ name: z.string() }).safeParse({ name: 5 })
    if (parsed.success) throw new Error('expected failure')
    const body = await faultResponse(toFault(parsed.error, CTX), true).json()
    expect(body.status).toBe(422)
    expect(body.issues[0].path).toBe('name')
  })
})

describe('taxonomy exhaustiveness spot checks', () => {
  it('statusForCode and classifyCode agree on the auth family', () => {
    expect(statusForCode('auth_unauthenticated')).toBe(401)
    expect(statusForCode('auth_forbidden')).toBe(403)
    expect(classifyCode('auth_unauthenticated').severity).toBe('expected')
  })
  it('breaker_open is non-retryable BY DEFINITION', () => {
    expect(classifyCode('upstream_breaker_open').isRetryable).toBe(false)
  })
  it('every code has a user message with no internals in it', () => {
    for (const msg of Object.values(USER_MESSAGES)) {
      expect(msg.length).toBeGreaterThan(0)
      expect(msg).not.toMatch(/stack|sql|postgres|env|secret/i)
    }
  })
})
