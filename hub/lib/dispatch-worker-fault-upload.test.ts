import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendFaultToSpool, drainSpool, spoolPath } from './fault-spool'
import { uploadSpooledFaults } from './dispatch-worker'
import type { WorkerConfig } from './dispatch-worker'

/* ════════════════════════════════════════════════════════════════════════════
   Upload-on-boot (§3 Layer 10). Boot is the first moment an HTTP call is
   safe, so this is where spooled crash records finally reach the Hub. It must
   never delay or break real work, and it must not lose records to a failure.
   ════════════════════════════════════════════════════════════════════════════ */

let dir: string
const cfg = { hubUrl: 'https://hub.example', secret: 's3cret', workerId: 'w1' } as unknown as WorkerConfig

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'))
  process.env.FAULT_SPOOL_PATH = path.join(dir, 'faults.ndjson')
})

afterEach(() => {
  delete process.env.FAULT_SPOOL_PATH
  fs.rmSync(dir, { recursive: true, force: true })
})

const ok = (status = 200) => vi.fn(async () => new Response('{}', { status })) as unknown as typeof fetch

describe('uploadSpooledFaults', () => {
  it('does nothing when there is no spool', async () => {
    const fetchFn = ok()
    expect(await uploadSpooledFaults(cfg, fetchFn)).toEqual({ uploaded: 0, failed: false })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('posts the batch with the worker secret and commits on success', async () => {
    appendFaultToSpool({ fault: { faultId: 'HUB-AAAAAAAA' } })
    const fetchFn = ok()
    expect(await uploadSpooledFaults(cfg, fetchFn)).toEqual({ uploaded: 1, failed: false })

    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://hub.example/api/worker/faults')
    expect((init.headers as Record<string, string>)['x-worker-secret']).toBe('s3cret')
    expect(JSON.parse(init.body as string).workerId).toBe('w1')
    // Committed: nothing left to retry.
    expect(drainSpool().claimed).toBe(false)
  })

  it('RESTORES the batch on a 5xx so the next boot retries it', async () => {
    appendFaultToSpool({ fault: { faultId: 'HUB-AAAAAAAA' } })
    expect(await uploadSpooledFaults(cfg, ok(503))).toEqual({ uploaded: 0, failed: true })
    expect(drainSpool().records).toHaveLength(1)
  })

  it('RESTORES on a network error too', async () => {
    appendFaultToSpool({ fault: { faultId: 'HUB-AAAAAAAA' } })
    const boom = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await uploadSpooledFaults(cfg, boom)).toEqual({ uploaded: 0, failed: true })
    expect(drainSpool().records).toHaveLength(1)
  })

  it.each([400, 413, 422])(
    'DROPS the batch on %i — conclusively invalid, and would block every later record forever',
    async (status) => {
      appendFaultToSpool({ fault: { faultId: 'HUB-AAAAAAAA' } })
      expect(await uploadSpooledFaults(cfg, ok(status))).toEqual({ uploaded: 0, failed: true })
      expect(drainSpool().claimed).toBe(false)
    },
  )

  it.each([
    [401, 'an AGY_WORKER_SECRET rotation briefly out of sync'],
    [403, 'a transient authorization failure'],
    [404, 'a worker updated before the Hub deployment carrying this route'],
    [429, 'rate limiting'],
  ])('RESTORES on %i (%s) — these recover on their own, so the records must survive', async (status) => {
    appendFaultToSpool({ fault: { faultId: 'HUB-AAAAAAAA' } })
    expect(await uploadSpooledFaults(cfg, ok(status))).toEqual({ uploaded: 0, failed: true })
    // The whole point: a self-recovering status must not destroy crash records.
    expect(drainSpool().records).toHaveLength(1)
  })

  it('keeps draining past the batch cap in ONE boot — a healthy worker never boots again', async () => {
    const total = 120 // > 2 batches of 50
    for (let i = 0; i < total; i++) appendFaultToSpool({ fault: { faultId: `HUB-R${i}` } })
    const fetchFn = ok()
    const res = await uploadSpooledFaults(cfg, fetchFn)
    expect(res).toEqual({ uploaded: total, failed: false })
    // Three batches: 50 + 50 + 20, all in this boot.
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3)
    expect(drainSpool().claimed).toBe(false)
  })

  it('stops the drain loop on failure and leaves the rest for next boot', async () => {
    for (let i = 0; i < 120; i++) appendFaultToSpool({ fault: { faultId: `HUB-R${i}` } })
    const fetchFn = ok(503)
    expect((await uploadSpooledFaults(cfg, fetchFn)).failed).toBe(true)
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    // Nothing lost — the whole spool is still owed.
    expect(drainSpool().records.length).toBeGreaterThan(0)
  })

  it('never throws, whatever the transport does', async () => {
    appendFaultToSpool({ fault: { faultId: 'HUB-AAAAAAAA' } })
    const weird = vi.fn(async () => ({ status: undefined }) as unknown as Response) as unknown as typeof fetch
    await expect(uploadSpooledFaults(cfg, weird)).resolves.toBeDefined()
  })

  it('discards an empty spool file rather than re-claiming it every boot', async () => {
    fs.writeFileSync(spoolPath(), '\n\n')
    const fetchFn = ok()
    expect(await uploadSpooledFaults(cfg, fetchFn)).toEqual({ uploaded: 0, failed: false })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(drainSpool().claimed).toBe(false)
  })

  /* ══════════════════════════════════════════════════════════════════════
     Bounded boot-drain budget (T-151). The old loop re-checked a live
     MAX_UPLOAD_BATCHES=10 ceiling every iteration, so >500 records lost the
     remainder silently (`failed: false` with records still unsent, invisible
     until a boot that might never come), and a continuously-appending
     producer could make an unbounded loop stall startup forever. The budget
     must instead be fixed ONCE from the first claimed snapshot's leftover.
     ══════════════════════════════════════════════════════════════════════ */

  const rawSpoolIds = () =>
    fs
      .readFileSync(spoolPath(), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { fault: { faultId: string } }).fault.faultId)

  it('drains a 501-record spool completely in 11 calls, with no remainder — the old ceiling stopped at 500', async () => {
    const total = 501
    for (let i = 0; i < total; i++) appendFaultToSpool({ fault: { faultId: `HUB-R${i}` } })
    const fetchFn = ok()
    const res = await uploadSpooledFaults(cfg, fetchFn)
    expect(res).toEqual({ uploaded: total, failed: false })
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(11)
    expect(drainSpool().claimed).toBe(false)
  })

  it.each([503, 401, 429])(
    'a %i on the second batch acknowledges exactly the first 50 and retains all 70 unacknowledged records in order',
    async (status) => {
      const total = 120
      for (let i = 0; i < total; i++) appendFaultToSpool({ fault: { faultId: `HUB-R${i}` } })
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValue(new Response('{}', { status })) as unknown as typeof fetch
      const res = await uploadSpooledFaults(cfg, fetchFn)
      expect(res).toEqual({ uploaded: 50, failed: true })
      expect(rawSpoolIds()).toEqual(Array.from({ length: 70 }, (_, i) => `HUB-R${i + 50}`))
    },
  )

  it('a 422 on the second batch permanently drops it but retains the untried tail', async () => {
    const total = 120
    for (let i = 0; i < total; i++) appendFaultToSpool({ fault: { faultId: `HUB-R${i}` } })
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValue(new Response('{}', { status: 422 })) as unknown as typeof fetch
    const res = await uploadSpooledFaults(cfg, fetchFn)
    expect(res).toEqual({ uploaded: 50, failed: true })
    // Records 50-99 were permanently rejected and dropped; only the final
    // 20, never attempted, remain.
    expect(rawSpoolIds()).toEqual(Array.from({ length: 20 }, (_, i) => `HUB-R${i + 100}`))
  })

  it('bounds the drain to the initial-snapshot budget under continuous concurrent appends — no record is lost', async () => {
    const initial = 120
    for (let i = 0; i < initial; i++) appendFaultToSpool({ fault: { faultId: `HUB-R${i}` } })
    let nextId = initial
    const posted: string[] = []
    const fetchFn = vi.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as RequestInit).body as string) as { faults: { fault: { faultId: string } }[] }
      posted.push(...body.faults.map((f) => f.fault.faultId))
      // A producer that never stops: append a fresh batch while this boot's
      // drain is still in flight.
      for (let i = 0; i < 30; i++) appendFaultToSpool({ fault: { faultId: `HUB-R${nextId++}` } })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const res = await uploadSpooledFaults(cfg, fetchFn)

    // The initial claim saw 120 records: one 50-record batch plus a 70-record
    // leftover, budgeting 1 + ceil(70/50) = 3 total batches — fixed at that
    // claim and never recomputed, so the appends below cannot extend it.
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3)
    expect(res).toEqual({ uploaded: 150, failed: false })

    const remaining = rawSpoolIds()
    const allCreated = Array.from({ length: nextId }, (_, i) => `HUB-R${i}`)
    const union = [...posted, ...remaining].sort(
      (a, b) => Number(a.slice('HUB-R'.length)) - Number(b.slice('HUB-R'.length)),
    )
    expect(union).toEqual(allCreated)
    expect(posted).toHaveLength(150)
    expect(remaining).toHaveLength(60)
  })
})
