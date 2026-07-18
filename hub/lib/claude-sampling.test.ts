import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  claudeChat,
  modelSupportsSamplingParams,
  CLAUDE_PRIMARY_MODEL,
  CLAUDE_BACKUP_MODEL,
} from './claude'

/* ════════════════════════════════════════════════════════════════════════════
   Sampling-parameter guard (the "EXA is too fast to be Fable 5" bug).

   Claude Fable 5 / Opus 4.7+ / Sonnet 5 reject `temperature` with a 400.
   Sending it unconditionally made EVERY Fable 5 request fail pre-stream, so
   the rotation silently served Sonnet 4.6 and the primary model never ran.
   These tests pin the request-body contract per model.
   ════════════════════════════════════════════════════════════════════════════ */

const realFetch = global.fetch

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
})

afterEach(() => {
  global.fetch = realFetch
  vi.clearAllMocks()
})

function stubClaude() {
  const mock = vi.fn(async () =>
    new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
  ) as unknown as typeof fetch
  global.fetch = mock
  return mock as ReturnType<typeof vi.fn>
}

const msg = [{ id: '1', role: 'user' as const, content: 'hi', timestamp: new Date().toISOString() }]

describe('modelSupportsSamplingParams', () => {
  it('rejects sampling params on Fable 5 / Mythos / Opus 4.7+ / Sonnet 5', () => {
    expect(modelSupportsSamplingParams('claude-fable-5')).toBe(false)
    expect(modelSupportsSamplingParams('claude-mythos-5')).toBe(false)
    expect(modelSupportsSamplingParams('claude-opus-4-7')).toBe(false)
    expect(modelSupportsSamplingParams('claude-opus-4-8')).toBe(false)
    expect(modelSupportsSamplingParams('claude-sonnet-5')).toBe(false)
  })

  it('allows sampling params on Sonnet 4.6 / Opus 4.6 and older', () => {
    expect(modelSupportsSamplingParams('claude-sonnet-4-6')).toBe(true)
    expect(modelSupportsSamplingParams('claude-opus-4-6')).toBe(true)
    expect(modelSupportsSamplingParams('claude-haiku-4-5-20251001')).toBe(true)
  })

  it('covers the configured primary/backup chain as expected', () => {
    expect(modelSupportsSamplingParams(CLAUDE_PRIMARY_MODEL)).toBe(false) // fable-5
    expect(modelSupportsSamplingParams(CLAUDE_BACKUP_MODEL)).toBe(true) // sonnet-4-6
  })
})

describe('claudeChat request body', () => {
  it('OMITS temperature for Fable 5 (it would 400 and demote the chain)', async () => {
    const mock = stubClaude()
    await claudeChat(msg, 'system', { model: 'claude-fable-5', temperature: 0.1 })
    const body = JSON.parse(String(mock.mock.calls[0][1]?.body))
    expect(body.model).toBe('claude-fable-5')
    expect(body).not.toHaveProperty('temperature')
  })

  it('keeps temperature for Sonnet 4.6', async () => {
    const mock = stubClaude()
    await claudeChat(msg, 'system', { model: 'claude-sonnet-4-6', temperature: 0.1 })
    const body = JSON.parse(String(mock.mock.calls[0][1]?.body))
    expect(body.temperature).toBe(0.1)
  })
})
