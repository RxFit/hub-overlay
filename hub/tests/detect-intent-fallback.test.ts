import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/chat/detect-intent — cross-provider fallback.

   Interview Mode (and therefore the ActionConfirmCard) can ONLY start from
   this route. It used to be Gemini-only: during a Gemini outage every action
   request silently resolved to intent:null, so no Confirm Card could ever
   render while the chat itself kept working on the Claude rotation — users
   were told to "approve via the Confirm Card" that never existed. These tests
   pin the Claude fallback and the intent-id normalization.
   ════════════════════════════════════════════════════════════════════════════ */

const { geminiState, claudeState, state } = vi.hoisted(() => ({
  geminiState: {
    // What the mocked Gemini generateContent does: 'ok' | 'throw'
    mode: 'ok' as 'ok' | 'throw',
    responseText: '{"intent":"post_chat_message","extractedEntities":{"space":"RxGrowth Engine"}}',
  },
  claudeState: {
    configured: true,
    // Per-model behavior keyed by model id; value is text to return or 'throw'
    responses: {} as Record<string, string | 'throw'>,
    calls: [] as string[],
  },
  state: { session: { user: { email: 'danny@rxfitatx.com' } } as unknown },
}))

vi.mock('@google/generative-ai', () => ({
  SchemaType: { OBJECT: 'object', STRING: 'string' },
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return {
        generateContent: async () => {
          if (geminiState.mode === 'throw') throw new Error('Gemini down')
          return { response: { text: () => geminiState.responseText } }
        },
      }
    }
  },
}))

vi.mock('@/lib/claude', () => ({
  CLAUDE_PRIMARY_MODEL: 'claude-fable-5',
  CLAUDE_BACKUP_MODEL: 'claude-sonnet-4-6',
  // Non-EXA classifier fallback is Haiku (Fable 5 is EXA-only).
  CLAUDE_FALLBACK_MODEL: 'claude-haiku-4-5-20251001',
  isClaudeConfigured: () => claudeState.configured,
  claudeChat: async (_msgs: unknown, _system: string, opts: { model: string }) => {
    claudeState.calls.push(opts.model)
    const behavior = claudeState.responses[opts.model]
    if (behavior === 'throw' || behavior === undefined) throw new Error(`${opts.model} down`)
    return behavior
  },
}))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => state.session),
}))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))

import { POST } from '@/app/api/chat/detect-intent/route'

const AVAILABLE = [
  { id: 'post_chat_message', description: 'Send a Google Chat message', expectedEntities: ['space', 'message'] },
  { id: 'create_task', description: 'Create a task', expectedEntities: ['description'] },
]

function req(body: unknown) {
  return new NextRequest('http://localhost/api/chat/detect-intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key'
  geminiState.mode = 'ok'
  geminiState.responseText = '{"intent":"post_chat_message","extractedEntities":{"space":"RxGrowth Engine"}}'
  claudeState.configured = true
  claudeState.responses = {}
  claudeState.calls = []
  state.session = { user: { email: 'danny@rxfitatx.com' } }
})

describe('detect-intent provider fallback', () => {
  it('serves from Gemini when it is healthy (no Claude call)', async () => {
    const res = await POST(req({ message: 'send a chat message', availableIntents: AVAILABLE }))
    const body = await res.json()
    expect(body).toEqual({ intent: 'post_chat_message', extractedEntities: { space: 'RxGrowth Engine' } })
    expect(claudeState.calls).toEqual([])
  })

  it('falls back to Claude Haiku when Gemini throws — the Confirm Card path survives a Gemini outage', async () => {
    geminiState.mode = 'throw'
    claudeState.responses['claude-haiku-4-5-20251001'] =
      '{"intent":"post_chat_message","extractedEntities":{"space":"RxGrowth Engine","message":"Domain migration items"}}'
    const res = await POST(req({ message: 'send the migration items to RxGrowth Engine', availableIntents: AVAILABLE }))
    const body = await res.json()
    expect(body.intent).toBe('post_chat_message')
    expect(body.extractedEntities.space).toBe('RxGrowth Engine')
    expect(claudeState.calls).toEqual(['claude-haiku-4-5-20251001'])
  })

  it('uses Haiku ONLY for the Claude fallback — never Fable 5 or Sonnet (Fable 5 is EXA-only)', async () => {
    geminiState.mode = 'throw'
    claudeState.responses['claude-haiku-4-5-20251001'] = '{"intent":"create_task","extractedEntities":{}}'
    const res = await POST(req({ message: 'create a task', availableIntents: AVAILABLE }))
    const body = await res.json()
    expect(body.intent).toBe('create_task')
    expect(claudeState.calls).toEqual(['claude-haiku-4-5-20251001'])
    expect(claudeState.calls).not.toContain('claude-fable-5')
    expect(claudeState.calls).not.toContain('claude-sonnet-4-6')
  })

  it('tolerates markdown fencing around the Claude JSON', async () => {
    geminiState.mode = 'throw'
    claudeState.responses['claude-haiku-4-5-20251001'] = '```json\n{"intent":"create_task","extractedEntities":{}}\n```'
    const res = await POST(req({ message: 'create a task', availableIntents: AVAILABLE }))
    const body = await res.json()
    expect(body.intent).toBe('create_task')
  })

  it('returns intent:null when every provider fails (prior behavior preserved)', async () => {
    geminiState.mode = 'throw'
    claudeState.responses['claude-haiku-4-5-20251001'] = 'throw'
    const res = await POST(req({ message: 'send a chat message', availableIntents: AVAILABLE }))
    expect(await res.json()).toEqual({ intent: null, extractedEntities: {} })
  })

  it('skips the Claude leg entirely when no Anthropic key is configured', async () => {
    geminiState.mode = 'throw'
    claudeState.configured = false
    const res = await POST(req({ message: 'send a chat message', availableIntents: AVAILABLE }))
    expect(await res.json()).toEqual({ intent: null, extractedEntities: {} })
    expect(claudeState.calls).toEqual([])
  })

  it('normalizes a hallucinated intent id to null (never trusts model output)', async () => {
    geminiState.responseText = '{"intent":"rm_rf_workspace","extractedEntities":{"x":"y"}}'
    const res = await POST(req({ message: 'hello', availableIntents: AVAILABLE }))
    const body = await res.json()
    expect(body.intent).toBeNull()
  })

  it('normalizes the empty-string "no match" intent to null and drops non-string entities', async () => {
    geminiState.responseText = '{"intent":"","extractedEntities":{"space":"Ops","count":3}}'
    const res = await POST(req({ message: 'what is the weather', availableIntents: AVAILABLE }))
    const body = await res.json()
    expect(body).toEqual({ intent: null, extractedEntities: { space: 'Ops' } })
  })

  it('still 401s unauthenticated callers before touching any provider', async () => {
    state.session = null
    const res = await POST(req({ message: 'hi', availableIntents: AVAILABLE }))
    expect(res.status).toBe(401)
  })
})
