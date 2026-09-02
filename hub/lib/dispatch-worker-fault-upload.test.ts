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

  it('DROPS the batch on a 4xx — a rejected batch would block every later record forever', async () => {
    appendFaultToSpool({ fault: { faultId: 'HUB-AAAAAAAA' } })
    expect(await uploadSpooledFaults(cfg, ok(422))).toEqual({ uploaded: 0, failed: true })
    expect(drainSpool().claimed).toBe(false)
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
})
