import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isClaudeConfigured } from './claude'
import { isGeminiConfigured } from './gemini'

/* ════════════════════════════════════════════════════════════════════════════
   Provider-configuration probes (P0 outage hardening).

   isGeminiConfigured / isClaudeConfigured are the non-throwing key-PRESENCE
   probes behind (a) the emergency cross-provider fallback decision in
   lib/gemini.ts and (b) the /api/admin/ai-health providerConfig badges. They
   must mirror the exact env fallback lists of getGenAI() / getApiKey() —
   including the Cloud Run case-variants — and never throw or leak key material.
   Real modules here (no mocks): these are the probes production runs.
   ════════════════════════════════════════════════════════════════════════════ */

const GEMINI_VARS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'] as const
const CLAUDE_VARS = ['ANTHROPIC_API_KEY', 'Anthropic_API_Key', 'anthropic_token'] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of [...GEMINI_VARS, ...CLAUDE_VARS]) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of [...GEMINI_VARS, ...CLAUDE_VARS]) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('isGeminiConfigured', () => {
  it('is false (and does not throw) when no Gemini key variable is set', () => {
    expect(isGeminiConfigured()).toBe(false)
  })

  it.each(GEMINI_VARS)('is true when %s is set (same fallback list as getGenAI)', (name) => {
    process.env[name] = 'k'
    expect(isGeminiConfigured()).toBe(true)
  })

  it('treats an empty-string key as missing (matches getGenAI, which would throw)', () => {
    process.env.GEMINI_API_KEY = ''
    expect(isGeminiConfigured()).toBe(false)
  })
})

describe('isClaudeConfigured', () => {
  it('is false (and does not throw) when no Anthropic key variable is set', () => {
    expect(isClaudeConfigured()).toBe(false)
  })

  it.each(CLAUDE_VARS)('is true when %s is set (incl. the Cloud Run case-variants)', (name) => {
    process.env[name] = 'k'
    expect(isClaudeConfigured()).toBe(true)
  })

  it('treats an empty-string key as missing (matches getApiKey, which would throw)', () => {
    process.env.ANTHROPIC_API_KEY = ''
    expect(isClaudeConfigured()).toBe(false)
  })
})
