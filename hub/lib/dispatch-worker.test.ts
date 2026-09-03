import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * lib/dispatch-worker.ts — the desktop worker loop.
 *
 * Driven entirely through injected deps (fetch/run/sleep), no real network or
 * agy. Locks: config parsing, the claim→execute→post cycle, typed-error
 * result posts, the heartbeat cancel channel aborting the agy child, result
 * retries into the idempotent CAS, and backoff on Hub trouble.
 */

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('@/lib/agy', () => ({
  agyGenerateText: vi.fn(),
  agyVersion: vi.fn().mockResolvedValue('1.1.13'),
  agyErrorType: (err: unknown) => (err as { agyError?: { type?: string } })?.agyError?.type ?? 'unknown',
  truncateAgyError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}))

import { BOOT_CANARY_MARKER, startWorker, workerConfigFromEnv, type WorkerConfig } from './dispatch-worker'

const CFG: WorkerConfig = {
  hubUrl: 'https://hub.test',
  secret: 's3cret',
  workerId: 'test-desktop',
  chatSlots: 1,
  workSlots: 0,
  version: 'abc123',
}

function jsonRes(status: number, body?: unknown): Response {
  return {
    status,
    json: async () => body ?? {},
  } as unknown as Response
}

interface Call {
  path: string
  body: Record<string, unknown>
}

/** Route fetch by URL suffix; record every call. */
function makeFetch(routes: {
  claim?: (n: number) => Response | Promise<Response>
  heartbeat?: (n: number) => Response | Promise<Response>
  result?: (n: number) => Response | Promise<Response>
}) {
  const calls: Call[] = []
  const counts = { claim: 0, heartbeat: 0, result: 0 }
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (u.endsWith('/api/worker/claim')) {
      counts.claim += 1
      calls.push({ path: 'claim', body })
      return routes.claim?.(counts.claim) ?? jsonRes(204)
    }
    if (u.includes('/heartbeat')) {
      counts.heartbeat += 1
      calls.push({ path: 'heartbeat', body })
      return routes.heartbeat?.(counts.heartbeat) ?? jsonRes(200, { ok: true, cancelRequested: false })
    }
    if (u.includes('/result')) {
      counts.result += 1
      calls.push({ path: 'result', body })
      return routes.result?.(counts.result) ?? jsonRes(200, { outcome: 'recorded' })
    }
    throw new Error(`unexpected url ${u}`)
  }) as unknown as typeof fetch
  return { fetchFn, calls, counts }
}

const instantSleep = () => Promise.resolve()

function jobWire(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    kind: 'chat_turn',
    attempt: 1,
    payloadText: 'the prompt',
    payloadMeta: null,
    deadlineAt: new Date(Date.now() + 45_000).toISOString(),
    heartbeatMs: 10_000,
    ...overrides,
  }
}

beforeEach(() => {
  vi.unstubAllEnvs()
})

describe('workerConfigFromEnv', () => {
  it('requires HUB_URL and the secret', () => {
    expect(workerConfigFromEnv({})).toHaveProperty('error')
    expect(workerConfigFromEnv({ HUB_URL: 'https://h' })).toHaveProperty('error')
    expect(workerConfigFromEnv({ AGY_WORKER_SECRET: 's' })).toHaveProperty('error')
  })

  it('applies defaults and strips trailing slashes', () => {
    const cfg = workerConfigFromEnv({ HUB_URL: 'https://hub.test///', AGY_WORKER_SECRET: 's' }) as WorkerConfig
    expect(cfg.hubUrl).toBe('https://hub.test')
    expect(cfg.workerId).toBe('danny-desktop')
    expect(cfg.chatSlots).toBe(1)
    expect(cfg.workSlots).toBe(0)
  })

  it('parses slot counts and the git SHA', () => {
    const cfg = workerConfigFromEnv({
      HUB_URL: 'https://h',
      AGY_WORKER_SECRET: 's',
      WORKER_CHAT_SLOTS: '2',
      WORKER_WORK_SLOTS: '1',
      WORKER_GIT_SHA: 'f'.repeat(80),
    }) as WorkerConfig
    expect(cfg.chatSlots).toBe(2)
    expect(cfg.workSlots).toBe(1)
    expect(cfg.version).toHaveLength(64)
  })
})

describe('claim → execute → post cycle', () => {
  it('executes a claimed job and posts the ok result with the worker secret header', async () => {
    const stop = new AbortController()
    const { fetchFn, calls } = makeFetch({
      claim: (n) => {
        if (n === 1) return jsonRes(200, { job: jobWire(), hubSha: 'abc123' })
        stop.abort()
        return jsonRes(204)
      },
    })
    const runFn = vi.fn().mockResolvedValue({ text: 'answer', model: 'm1', usage: { outputTokens: 9 }, raw: {}, latencyMs: 800 })

    await startWorker(CFG, { fetchFn, runFn, sleepFn: instantSleep, agyVersionFn: async () => '1.1.13' }, stop.signal)

    expect(runFn).toHaveBeenCalledWith('the prompt', expect.objectContaining({ signal: expect.anything() }))
    const result = calls.find((c) => c.path === 'result')
    expect(result?.body).toMatchObject({
      workerId: 'test-desktop',
      attempt: 1,
      status: 'ok',
      text: 'answer',
      model: 'm1',
      latencyMs: 800,
    })
    const claim = calls.find((c) => c.path === 'claim')
    expect(claim?.body).toMatchObject({ workerId: 'test-desktop', kinds: ['chat_turn'], waitMs: 25_000, version: 'abc123', agyVersion: '1.1.13' })
  })

  it('posts a typed error result when the run fails', async () => {
    const stop = new AbortController()
    const { fetchFn, calls } = makeFetch({
      claim: (n) => {
        if (n === 1) return jsonRes(200, { job: jobWire() })
        stop.abort()
        return jsonRes(204)
      },
    })
    const runFn = vi.fn().mockRejectedValue(Object.assign(new Error('too slow'), { agyError: { type: 'timeout', message: 'too slow' } }))

    await startWorker(CFG, { fetchFn, runFn, sleepFn: instantSleep, agyVersionFn: async () => null }, stop.signal)

    const result = calls.find((c) => c.path === 'result')
    expect(result?.body).toMatchObject({ status: 'error', errorClass: 'timeout', error: 'too slow' })
  })

  it('passes model/effort hints from payloadMeta into the run', async () => {
    const stop = new AbortController()
    const { fetchFn } = makeFetch({
      claim: (n) => {
        if (n === 1) return jsonRes(200, { job: jobWire({ payloadMeta: { model: 'gemini-3-pro', effort: 'low' } }) })
        stop.abort()
        return jsonRes(204)
      },
    })
    const runFn = vi.fn().mockResolvedValue({ text: 'x', raw: {}, latencyMs: 1 })
    await startWorker(CFG, { fetchFn, runFn, sleepFn: instantSleep, agyVersionFn: async () => null }, stop.signal)
    expect(runFn).toHaveBeenCalledWith('the prompt', expect.objectContaining({ model: 'gemini-3-pro', effort: 'low' }))
  })

  it('passes validated addDirs from payloadMeta into the run', async () => {
    const stop = new AbortController()
    const { fetchFn } = makeFetch({
      claim: (n) => {
        if (n === 1) return jsonRes(200, { job: jobWire({ payloadMeta: { addDirs: ['.'] } }) })
        stop.abort()
        return jsonRes(204)
      },
    })
    const runFn = vi.fn().mockResolvedValue({ text: 'x', raw: {}, latencyMs: 1 })
    await startWorker(CFG, { fetchFn, runFn, sleepFn: instantSleep, agyVersionFn: async () => null }, stop.signal)
    expect(runFn).toHaveBeenCalledWith('the prompt', expect.objectContaining({ addDirs: ['.'] }))
  })

  it('a Hub cancel on the heartbeat aborts the agy run and posts errorClass abort', async () => {
    const stop = new AbortController()
    const { fetchFn, calls } = makeFetch({
      claim: (n) => {
        if (n === 1) return jsonRes(200, { job: jobWire({ heartbeatMs: 1_000 }) })
        stop.abort()
        return jsonRes(204)
      },
      heartbeat: () => jsonRes(200, { ok: true, cancelRequested: true }),
    })
    // The run hangs until its AbortSignal fires — exactly agyGenerateText's contract.
    const runFn = vi.fn().mockImplementation(
      (_p: string, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { agyError: { type: 'abort', message: 'aborted' } })),
          )
        }),
    )

    await startWorker(CFG, { fetchFn, runFn, sleepFn: instantSleep, agyVersionFn: async () => null }, stop.signal)

    const result = calls.find((c) => c.path === 'result')
    expect(result?.body).toMatchObject({ status: 'error', errorClass: 'abort' })
  }, 10_000)

  it('a transient heartbeat 500 skips the beat — the run completes and posts ok', async () => {
    const stop = new AbortController()
    const { fetchFn, calls } = makeFetch({
      claim: (n) => {
        if (n === 1) return jsonRes(200, { job: jobWire({ heartbeatMs: 1_000 }) })
        stop.abort()
        return jsonRes(204)
      },
      heartbeat: () => jsonRes(500, { error: 'db blip' }), // must NOT abort
    })
    // The run outlives one heartbeat, then completes normally.
    const runFn = vi.fn().mockImplementation(
      (_p: string, opts: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          opts.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { agyError: { type: 'abort', message: 'aborted' } })),
          )
          setTimeout(() => resolve({ text: 'survived the blip', raw: {}, latencyMs: 1_500 }), 1_500)
        }),
    )

    await startWorker(CFG, { fetchFn, runFn, sleepFn: instantSleep, agyVersionFn: async () => null }, stop.signal)

    const result = calls.find((c) => c.path === 'result')
    expect(result?.body).toMatchObject({ status: 'ok', text: 'survived the blip' })
  }, 10_000)

  it('retries the result post into the idempotent CAS until acked', async () => {
    const stop = new AbortController()
    const { fetchFn, counts } = makeFetch({
      claim: (n) => {
        if (n === 1) return jsonRes(200, { job: jobWire() })
        stop.abort()
        return jsonRes(204)
      },
      result: (n) => {
        if (n === 1) throw new Error('network blip')
        return jsonRes(200, { outcome: 'duplicate' })
      },
    })
    const runFn = vi.fn().mockResolvedValue({ text: 'x', raw: {}, latencyMs: 1 })
    await startWorker(CFG, { fetchFn, runFn, sleepFn: instantSleep, agyVersionFn: async () => null }, stop.signal)
    expect(counts.result).toBe(2)
  })

  it('backs off on claim rejection instead of hammering the Hub', async () => {
    const stop = new AbortController()
    const sleeps: number[] = []
    const { fetchFn, counts } = makeFetch({
      claim: (n) => {
        if (n >= 3) stop.abort()
        return jsonRes(401, { error: 'Unauthorized' })
      },
    })
    await startWorker(
      CFG,
      {
        fetchFn,
        runFn: vi.fn(),
        sleepFn: (ms: number) => {
          sleeps.push(ms)
          return Promise.resolve()
        },
        agyVersionFn: async () => null,
      },
      stop.signal,
    )
    expect(counts.claim).toBeGreaterThanOrEqual(3)
    expect(sleeps.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...sleeps)).toBeGreaterThan(sleeps[0]) // exponential growth
  })

  it('an empty long-poll (204) reconnects immediately with no backoff', async () => {
    const stop = new AbortController()
    const sleeps: number[] = []
    const { fetchFn, counts } = makeFetch({
      claim: (n) => {
        if (n >= 3) stop.abort()
        return jsonRes(204)
      },
    })
    await startWorker(
      CFG,
      { fetchFn, runFn: vi.fn(), sleepFn: (ms) => (sleeps.push(ms), Promise.resolve()), agyVersionFn: async () => null },
      stop.signal,
    )
    expect(counts.claim).toBeGreaterThanOrEqual(3)
    expect(sleeps).toHaveLength(0)
  })
})

describe('boot canary (hardening move 2)', () => {
  it('workerConfigFromEnv defaults the canary ON, with WORKER_CANARY=off as the escape hatch', () => {
    const base = { HUB_URL: 'https://hub.test', AGY_WORKER_SECRET: 's' }
    const on = workerConfigFromEnv(base) as WorkerConfig
    expect(on.canary).toBe(true)
    const off = workerConfigFromEnv({ ...base, WORKER_CANARY: 'off' }) as WorkerConfig
    expect(off.canary).toBe(false)
    const tuned = workerConfigFromEnv({ ...base, WORKER_CANARY_RETRY_MS: '60000' }) as WorkerConfig
    expect(tuned.canaryRetryMs).toBe(60_000)
  })

  it('a passing canary runs BEFORE any claim, then slots proceed', async () => {
    const stop = new AbortController()
    const { fetchFn, counts } = makeFetch({
      claim: () => {
        stop.abort()
        return jsonRes(204)
      },
    })
    const prompts: string[] = []
    const runFn = vi.fn(async (prompt: string) => {
      prompts.push(prompt)
      return { text: `sure: ${BOOT_CANARY_MARKER}`, model: 'm', raw: {}, latencyMs: 5 }
    })
    await startWorker({ ...CFG, canary: true }, { fetchFn, runFn, sleepFn: instantSleep, agyVersionFn: async () => null }, stop.signal)

    expect(prompts[0]).toContain(BOOT_CANARY_MARKER) // canary ran first…
    expect(counts.claim).toBeGreaterThan(0)          // …and slots then claimed
  })

  it('envelope drift (readable text WITHOUT the marker) blocks claiming until a retry passes', async () => {
    const stop = new AbortController()
    const { fetchFn, counts } = makeFetch({
      claim: () => {
        stop.abort()
        return jsonRes(204)
      },
    })
    let calls = 0
    const runFn = vi.fn(async () => {
      calls += 1
      // First answer is drifted noise; the retry round-trips the marker.
      return calls === 1
        ? { text: 'thinking about your request…', raw: {}, latencyMs: 5 }
        : { text: BOOT_CANARY_MARKER, raw: {}, latencyMs: 5 }
    })
    const sleeps: number[] = []
    const sleepFn = async (ms: number) => { sleeps.push(ms) }

    await startWorker(
      { ...CFG, canary: true, canaryRetryMs: 123_000 },
      { fetchFn, runFn, sleepFn, agyVersionFn: async () => null },
      stop.signal,
    )

    expect(runFn).toHaveBeenCalledTimes(2)
    expect(sleeps).toContain(123_000) // the failing gate waited on the slow clock
    expect(counts.claim).toBeGreaterThan(0)
  })

  it('a typed agy failure also blocks claiming (no claim before the gate passes)', async () => {
    const stop = new AbortController()
    const { fetchFn, counts } = makeFetch({})
    const runFn = vi.fn(async () => {
      throw Object.assign(new Error('bad token'), { agyError: { type: 'auth', message: 'bad token' } })
    })
    // Abort from the sleep between retries — the worker never reaches a claim.
    const sleepFn = async () => { stop.abort() }

    await startWorker({ ...CFG, canary: true }, { fetchFn, runFn, sleepFn, agyVersionFn: async () => null }, stop.signal)
    expect(counts.claim).toBe(0)
  })

  it('canary absent/off: behavior is exactly the pre-canary worker (no marker prompt)', async () => {
    const stop = new AbortController()
    const { fetchFn } = makeFetch({
      claim: () => {
        stop.abort()
        return jsonRes(204)
      },
    })
    const runFn = vi.fn()
    await startWorker(CFG, { fetchFn, runFn, sleepFn: instantSleep, agyVersionFn: async () => null }, stop.signal)
    expect(runFn).not.toHaveBeenCalled()
  })
})
