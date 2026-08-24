import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

/**
 * lib/runs.ts — the AI runs ledger.
 *
 * Locks the two hard guarantees (mirroring ai-audit.test conventions):
 *  1. REDACTION — toRunRow is pure and stores provenance, never content:
 *     the prompt becomes length + fingerprint, meta drops body-like keys and
 *     non-primitive values, error text is flattened + bounded.
 *  2. BEST-EFFORT — recordAiRun swallows insert failures into an ai_error
 *     telemetry line; it never throws into the request path.
 */

const { insertMock, valuesMock, emitMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  valuesMock: vi.fn(),
  emitMock: vi.fn(),
}))

vi.mock('./db', () => ({
  db: {
    insert: insertMock,
    select: vi.fn(),
  },
}))
vi.mock('./observability', () => ({
  emit: emitMock,
}))

import { toRunRow, recordAiRun, fingerprintPrompt, type AiRunInput } from './runs'

beforeEach(() => {
  insertMock.mockReset().mockReturnValue({ values: valuesMock })
  valuesMock.mockReset().mockResolvedValue(undefined)
  emitMock.mockReset()
})

const baseInput: AiRunInput = {
  engine: 'agy',
  source: 'chat',
  status: 'ok',
  latencyMs: 1234,
}

describe('toRunRow — redaction contract', () => {
  it('stores prompt length and fingerprint, never the prompt', () => {
    const prompt = 'System: secret business context\n\nUser: sensitive question'
    const row = toRunRow({ ...baseInput, prompt })
    expect(row.promptChars).toBe(prompt.length)
    expect(row.promptSha256).toBe(crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16))
    expect(JSON.stringify(row)).not.toContain('sensitive question')
    expect(JSON.stringify(row)).not.toContain('secret business context')
  })

  it('accepts a pre-computed fingerprint when the prompt text is already scrubbed', () => {
    const row = toRunRow({ ...baseInput, promptFingerprint: { chars: 42, sha256: 'abcd1234abcd1234' } })
    expect(row.promptChars).toBe(42)
    expect(row.promptSha256).toBe('abcd1234abcd1234')
    // A live prompt always wins over the passthrough fields.
    const live = toRunRow({ ...baseInput, prompt: 'live', promptFingerprint: { chars: 42, sha256: 'abcd1234abcd1234' } })
    expect(live.promptChars).toBe(4)
    expect(live.promptSha256).toBe(fingerprintPrompt('live'))
    // Null-safe when the reaped row never had provenance either.
    const empty = toRunRow({ ...baseInput, promptFingerprint: { chars: null, sha256: null } })
    expect(empty.promptChars).toBeNull()
    expect(empty.promptSha256).toBeNull()
  })

  it('identical prompts fingerprint identically (cache-hit correlation)', () => {
    expect(fingerprintPrompt('same prompt')).toBe(fingerprintPrompt('same prompt'))
    expect(fingerprintPrompt('same prompt')).not.toBe(fingerprintPrompt('different prompt'))
    expect(fingerprintPrompt('')).toBeNull()
    expect(fingerprintPrompt(null)).toBeNull()
  })

  it('drops content-bearing and non-primitive meta keys, keeps flags and string arrays', () => {
    const row = toRunRow({
      ...baseInput,
      meta: {
        markerVerified: true,
        envelopeKeys: ['response', 'model', 'usage'],
        response: 'THE FULL MODEL ANSWER',
        raw: { whole: 'envelope' },
        nested: { smuggled: 'body' },
      },
    })
    expect(row.meta).toEqual({ markerVerified: true, envelopeKeys: ['response', 'model', 'usage'] })
  })

  it('flattens and bounds error text', () => {
    const row = toRunRow({
      ...baseInput,
      status: 'error',
      errorClass: 'parse',
      error: `multi\nline\t${'x'.repeat(400)}`,
    })
    expect(row.error).not.toContain('\n')
    expect(row.error!.length).toBeLessThanOrEqual(301) // 300 + ellipsis
    expect(row.errorClass).toBe('parse')
  })

  it('extracts usage counters and null-safes the rest', () => {
    const row = toRunRow({
      ...baseInput,
      model: '  gemini-3-flash  ',
      usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 96 },
      userEmail: '  Danny@RxFitATX.com ',
    })
    expect(row.model).toBe('gemini-3-flash')
    expect(row.inputTokens).toBe(120)
    expect(row.outputTokens).toBe(8)
    expect(row.cacheReadTokens).toBe(96)
    expect(row.totalTokens).toBeNull()
    expect(row.userEmail).toBe('danny@rxfitatx.com')
    expect(row.promptChars).toBeNull()
    expect(row.promptSha256).toBeNull()
    expect(row.meta).toBeNull()
  })

  it('never records negative latency', () => {
    expect(toRunRow({ ...baseInput, latencyMs: -5 }).latencyMs).toBe(0)
  })
})

describe('recordAiRun — best-effort contract', () => {
  it('inserts the redacted row', async () => {
    await recordAiRun({ ...baseInput, prompt: 'p', requestId: 'req-1' })
    expect(insertMock).toHaveBeenCalledTimes(1)
    const row = valuesMock.mock.calls[0][0]
    expect(row.engine).toBe('agy')
    expect(row.requestId).toBe('req-1')
    expect(row.promptChars).toBe(1)
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('swallows insert failures into an ai_error telemetry line', async () => {
    valuesMock.mockRejectedValueOnce(new Error('connection refused'))
    await expect(recordAiRun({ ...baseInput, requestId: 'req-2' })).resolves.toBeUndefined()
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ai_error', code: 'ai_run_write_failed', requestId: 'req-2' }),
    )
  })
})
