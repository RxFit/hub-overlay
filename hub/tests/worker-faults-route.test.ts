import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/fault-report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fault-report')>()
  return { ...actual, reportFault: vi.fn() }
})
import { reportFault } from '@/lib/fault-report'
import { POST } from '@/app/api/worker/faults/route'
import { _resetWorkerFaultDedupeForTests } from '@/lib/worker-fault-dedupe'

const reportMock = vi.mocked(reportFault)
const SECRET = 'worker-secret-value'

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/worker/faults (§3 Layer 10) — the sink that finally lets the Hub
   say WHY a desktop worker went quiet. The secret authenticates the sender;
   it does not make the payload trustworthy, so the suite pins the trust
   posture as hard as the happy path.
   ════════════════════════════════════════════════════════════════════════════ */

function post(body: unknown, opts: { secret?: string | null; contentLength?: string } = {}) {
  const text = JSON.stringify(body)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.secret !== null) headers['x-worker-secret'] = opts.secret ?? SECRET
  if (opts.contentLength) headers['content-length'] = opts.contentLength
  return new NextRequest('http://localhost/api/worker/faults', { method: 'POST', headers, body: text })
}

const fault = (over: Record<string, unknown> = {}) => ({
  origin: 'uncaughtException',
  fault: {
    faultId: 'HUB-ABCDEFGH',
    fingerprint: 'deadbeef',
    code: 'internal',
    severity: 'fatal',
    message: 'the worker died',
    ts: '2026-08-01T00:00:00.000Z',
    errName: 'Error',
    stack: 'boot@lib/dispatch-worker.ts',
    ...over,
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  _resetWorkerFaultDedupeForTests()
  process.env.AGY_WORKER_SECRET = SECRET
})

describe('machine auth — identical posture to /api/worker/claim', () => {
  it('503s when the secret is unset (the kill switch)', async () => {
    delete process.env.AGY_WORKER_SECRET
    const res = await POST(post({ workerId: 'w1', faults: [fault()] }))
    expect(res.status).toBe(503)
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('401s on a wrong or missing secret', async () => {
    expect((await POST(post({ workerId: 'w1', faults: [fault()] }, { secret: 'nope' }))).status).toBe(401)
    expect((await POST(post({ workerId: 'w1', faults: [fault()] }, { secret: null }))).status).toBe(401)
    expect(reportMock).not.toHaveBeenCalled()
  })
})

describe('ingest', () => {
  it('accepts a batch and reports each record', async () => {
    const res = await POST(post({ workerId: 'w1', faults: [fault(), fault({ faultId: 'HUB-BBBBBBBB' })] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accepted: ['HUB-ABCDEFGH', 'HUB-BBBBBBBB'], duplicate: [] })
    expect(reportMock).toHaveBeenCalledTimes(2)
  })

  it('preserves the ORIGINAL crash time and labels the worker service', async () => {
    await POST(post({ workerId: 'w1', faults: [fault()] }))
    const [, opts] = reportMock.mock.calls[0]
    // A spooled record uploaded on the next boot can be hours old; stamping
    // it with ingest time would misdate the incident.
    expect(opts?.occurredAt).toBe('2026-08-01T00:00:00.000Z')
    // Never 'hub' — that would merge worker crashes into the server's groups.
    expect(opts?.service).toBe('hub-worker')
  })

  it('marks the record as a worker process fault regardless of what was sent', async () => {
    await POST(post({ workerId: 'w1', faults: [fault({ layer: 'route', module: 'spoofed' })] }))
    expect(reportMock.mock.calls[0][0]).toMatchObject({ layer: 'process', module: 'dispatch-worker' })
  })

  it('is idempotent — a replayed batch reports once and returns the duplicates', async () => {
    await POST(post({ workerId: 'w1', faults: [fault()] }))
    const res = await POST(post({ workerId: 'w1', faults: [fault()] }))
    expect(await res.json()).toEqual({ accepted: [], duplicate: ['HUB-ABCDEFGH'] })
    expect(reportMock).toHaveBeenCalledTimes(1)
  })
})

describe('the payload is data, not gospel', () => {
  it('RE-SCRUBS free text rather than trusting the worker scrubbed it', async () => {
    await POST(
      post({
        workerId: 'w1',
        faults: [
          fault({
            message: 'died with password=hunter2 for danny@rxfitatx.com',
            stack: 'at x (Bearer eyJhbGciOiJIUzI1NiJ9.body.sig)',
          }),
        ],
      }),
    )
    const serialized = JSON.stringify(reportMock.mock.calls[0][0])
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('eyJ')
    expect(serialized).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/)
  })

  it('rejects a `code` outside the CLOSED taxonomy — shape alone does not bound cardinality', async () => {
    // `internal_12345` matches a /^[a-z0-9_]{1,40}$/ shape perfectly well, so
    // a shape check would let a buggy worker mint unbounded metric labels.
    for (const code of ['a'.repeat(200), 'internal_12345', 'totally_made_up']) {
      reportMock.mockClear()
      const res = await POST(post({ workerId: 'w1', faults: [fault({ code })] }))
      expect(res.status, `expected ${code} to be rejected`).toBe(422)
      expect(reportMock).not.toHaveBeenCalled()
    }
  })

  it('accepts every real FaultCode, so the guard cannot drift from the taxonomy', async () => {
    for (const code of ['internal', 'db_error', 'upstream_5xx', 'worker_timeout']) {
      reportMock.mockClear()
      const res = await POST(post({ workerId: 'w1', faults: [fault({ code, faultId: 'HUB-ZZZZZZZZ' })] }))
      expect(res.status, `expected ${code} to be accepted`).toBe(200)
    }
  })

  it('forwards the spooled V8 stack as rawStack so Error Reporting groups by callsite', async () => {
    // The record's top-level `message` is the scrubbed V8 stack (line numbers
    // kept); fault.stack is the normalized-frames derivation. Dropping it
    // grouped every worker crash by message instead of callsite.
    const entry = { ...fault(), message: 'Error: boom\n    at boot (/app/hub/lib/dispatch-worker.ts:31:9)' }
    await POST(post({ workerId: 'w1', faults: [entry] }))
    expect(reportMock.mock.calls[0][1]?.rawStack).toContain('dispatch-worker.ts:31:9')
  })

  it('re-scrubs the forwarded stack too', async () => {
    const entry = { ...fault(), message: 'Error: x\n    at f (/app/x.ts:1:1) password=hunter2' }
    await POST(post({ workerId: 'w1', faults: [entry] }))
    expect(reportMock.mock.calls[0][1]?.rawStack).not.toContain('hunter2')
  })

  it('rejects a malformed faultId and an over-long batch', async () => {
    expect((await POST(post({ workerId: 'w1', faults: [fault({ faultId: 'nope' })] }))).status).toBe(422)
    const many = Array.from({ length: 51 }, (_, i) => fault({ faultId: `HUB-AAAAAA${String(i % 10)}A` }))
    expect((await POST(post({ workerId: 'w1', faults: many }))).status).toBe(422)
  })

  it('validation errors echo PATHS only, never the offending values', async () => {
    const res = await POST(post({ workerId: 'w1', faults: [fault({ code: 'sk-supersecret-value-here' })] }))
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('supersecret')
    expect(body.issues[0].path).toContain('code')
  })

  it('REJECTS a `ts` carrying free text — it bypasses the draft rebuild and reaches the logs raw', async () => {
    // `ts` does not travel in the rebuilt draft; it leaves via reportFault's
    // options bag and is spliced into the record without passing
    // scrubFreeText. A bare string here was a hole you could post a refresh
    // token through.
    const leak = 'refresh_token=1//0gLeAkEdSeCrEtTokenValue danny@rxfitatx.com'
    const res = await POST(post({ workerId: 'w1', faults: [fault({ ts: leak })] }))
    expect(res.status).toBe(422)
    expect(reportMock).not.toHaveBeenCalled()
    expect(JSON.stringify(await res.json())).not.toContain('0gLeAkEd')
  })

  it('REJECTS a non-datetime `ts` — a forged incident time on a record the Hub vouches for', async () => {
    expect((await POST(post({ workerId: 'w1', faults: [fault({ ts: 'garbage-not-a-date' })] }))).status).toBe(422)
    expect((await POST(post({ workerId: 'w1', faults: [fault({ ts: 'x'.repeat(500) })] }))).status).toBe(422)
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('caps the issue list so one bad batch cannot become a multi-MB response', async () => {
    // zod v3 records a .max() violation but still parses every element, so
    // the oversized batch is rejected by an explicit length check first.
    // Over the 50-item cap but comfortably under the 512 KB byte cap, so this
    // exercises the item check rather than tripping the body limit first.
    const many = Array.from({ length: 300 }, () => fault({ faultId: 'not-valid' }))
    const res = await POST(post({ workerId: 'w1', faults: many }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.issues.length).toBeLessThanOrEqual(10)
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('413s a body that EXCEEDS the cap even with NO content-length header', async () => {
    // The header is a hint from the party this route does not trust, and
    // Number(null) is 0 (not NaN), so a header-only check passed a chunked
    // request straight through to req.json(). The cap is enforced while
    // reading now, so an oversized body is rejected without being buffered.
    const huge = JSON.stringify({ workerId: 'w1', faults: [fault({ message: 'x'.repeat(700 * 1024) })] })
    const req = new NextRequest('http://localhost/api/worker/faults', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-secret': SECRET },
      body: huge,
    })
    expect(req.headers.get('content-length')).toBeNull()
    expect((await POST(req)).status).toBe(413)
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('413s an oversized declared body and 400s invalid JSON', async () => {
    const big = post({ workerId: 'w1', faults: [fault({ message: 'y'.repeat(600 * 1024) })] })
    expect((await POST(big)).status).toBe(413)
    const bad = new NextRequest('http://localhost/api/worker/faults', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-secret': SECRET },
      body: 'not json{',
    })
    expect((await POST(bad)).status).toBe(400)
  })
})
