import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ChatMessage } from '@/types'
import { streamChat, streamGeminiChat, friendlyModelError, __resetModelCooldownsForTest } from './gemini'

/* ════════════════════════════════════════════════════════════════════════════
   Rotation branches NS-8 left uncovered (NS-11): cooldown re-entry after
   expiry, the all-models-cooling terminal path, the Gemini connect-race
   timeout, the degraded-model banner, the missing-key fast-fail, and the
   legacy text-only wrapper. Same deterministic mock seam as lib/gemini.test.ts
   (Claude + Gemini SDKs stubbed, fake timers drive every clock).
   ════════════════════════════════════════════════════════════════════════════ */

const hoisted = vi.hoisted(() => ({
  claudeBehavior: null as null | ((model: string) => AsyncGenerator<string>),
  geminiBehavior: null as null | ((model: string) => Promise<{ stream: AsyncIterable<{ text(): string }> }>),
  claudeCalls: [] as string[],
  geminiCalls: [] as string[],
  // False = the emergency cross-provider fallback (P0) stays disengaged, so
  // every assertion below exercises the same terminal paths as pre-P0.
  claudeConfigured: false,
}))

vi.mock('@/lib/claude', () => ({
  isClaudeConfigured: () => hoisted.claudeConfigured,
  streamClaudeChat: (_msgs: unknown, _sys: unknown, opts?: { model?: string }) => {
    const model = opts?.model ?? 'claude-fable-5'
    hoisted.claudeCalls.push(model)
    if (!hoisted.claudeBehavior) throw new Error('claudeBehavior not set')
    return hoisted.claudeBehavior(model)
  },
}))

vi.mock('@google/generative-ai', () => {
  class GoogleGenerativeAI {
    getGenerativeModel({ model }: { model: string }) {
      return {
        startChat: () => ({
          sendMessageStream: (_content: string) => {
            hoisted.geminiCalls.push(model)
            if (!hoisted.geminiBehavior) throw new Error('geminiBehavior not set')
            return hoisted.geminiBehavior(model)
          },
        }),
      }
    }
  }
  return { GoogleGenerativeAI }
})

const MESSAGES: ChatMessage[] = [{ id: '1', role: 'user', content: 'hello', timestamp: '' } as ChatMessage]

async function* claudeYield(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c
}
function geminiStream(chunks: string[]) {
  return Promise.resolve({
    stream: {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield { text: () => c }
      },
    },
  })
}

async function collect(gen: AsyncGenerator<string | { modelUsed: string }>) {
  const textParts: string[] = []
  const models: string[] = []
  let error: Error | null = null
  try {
    for await (const chunk of gen) {
      if (typeof chunk === 'object' && chunk && 'modelUsed' in chunk) models.push(chunk.modelUsed)
      else textParts.push(chunk as string)
    }
  } catch (e) {
    error = e as Error
  }
  return { text: textParts.join(''), models, error }
}

beforeEach(() => {
  hoisted.claudeBehavior = null
  hoisted.geminiBehavior = null
  hoisted.claudeCalls.length = 0
  hoisted.geminiCalls.length = 0
  hoisted.claudeConfigured = false
  __resetModelCooldownsForTest()
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  __resetModelCooldownsForTest()
})

/* NOTE: defined FIRST so the module-level GenAI client cache is still cold —
   getGenAI() only checks the env before the first successful init. */
describe('missing Gemini API key', () => {
  it('fast-fails the whole Gemini chain (auth-class error, no second-model retry)', async () => {
    const saved = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    }
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_API_KEY
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
    try {
      const { error, text } = await collect(streamChat(MESSAGES, 'sys', 'recall'))
      expect(text).toBe('')
      expect(error?.message).toContain('No Gemini API key found')
      // Auth-class failure: the rest of the Gemini chain was never attempted.
      expect(hoisted.geminiCalls).toEqual([])
      // The user-facing string frames it as provider configuration, not leak.
      expect(friendlyModelError(error)).toContain('provider configuration')
    } finally {
      Object.assign(process.env, saved)
    }
  })
})

describe('cooldown re-entry (Claude chain)', () => {
  it('skips a cooled-down model, then retries it once the cooldown expires', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    let fableUp = false
    hoisted.claudeBehavior = (model) => {
      if (model === 'claude-fable-5' && !fableUp) throw new Error('fable down')
      return claudeYield([`${model} says hi`])
    }

    // Call 1: Fable fails pre-stream → Sonnet serves.
    const r1 = await collect(streamChat(MESSAGES, 'sys', 'interview'))
    expect(r1.error).toBeNull()
    expect(hoisted.claudeCalls).toEqual(['claude-fable-5', 'claude-sonnet-4-6'])
    expect(r1.models).toEqual(['Claude Fable 5', 'Claude Sonnet 4.6']) // rotation visible to the UI

    // Call 2 (inside the 5-min error cooldown): Fable is not even attempted.
    const r2 = await collect(streamChat(MESSAGES, 'sys', 'interview'))
    expect(r2.error).toBeNull()
    expect(hoisted.claudeCalls).toEqual(['claude-fable-5', 'claude-sonnet-4-6', 'claude-sonnet-4-6'])

    // Cooldown expires (error cooldown = 300s) → Fable is tried FIRST again.
    fableUp = true
    vi.advanceTimersByTime(301_000)
    const r3 = await collect(streamChat(MESSAGES, 'sys', 'interview'))
    expect(r3.error).toBeNull()
    expect(hoisted.claudeCalls.at(-1)).toBe('claude-fable-5')
    expect(r3.text).toBe('claude-fable-5 says hi')
  })
})

describe('Claude auth-failure cooldown tier (P2 FIX2)', () => {
  it('records the 30-min AUTH cooldown (not the 5-min real-failure tier) on a Claude auth failure', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    let fableAuthFails = true
    hoisted.claudeBehavior = (model) => {
      if (model === 'claude-fable-5' && fableAuthFails) {
        // Auth-class failure (shared-credential problem): must get the long tier.
        throw Object.assign(new Error('401 unauthorized'), { claudeError: { type: 'auth' } })
      }
      return claudeYield([`${model} says hi`])
    }
    hoisted.geminiBehavior = () => geminiStream(['gem'])

    // Call 1: Fable auth-fails → the shared-credential break skips Sonnet and
    // hands off to Gemini. Fable is now recorded in the AUTH cooldown tier.
    const r1 = await collect(streamChat(MESSAGES, 'sys', 'interview'))
    expect(hoisted.claudeCalls).toEqual(['claude-fable-5']) // Sonnet skipped (auth break)
    expect(r1.text).toBe('gem')

    // Fable "recovers" upstream, but advance PAST the 5-min real-failure tier
    // (301s) and stay UNDER the 30-min auth tier. If FIX2 is correct, Fable is
    // still cooling and is skipped; Sonnet serves. (Pre-fix it would be the
    // 5-min tier and Fable would be retried first here.)
    fableAuthFails = false
    hoisted.claudeCalls.length = 0
    vi.advanceTimersByTime(301_000)
    const r2 = await collect(streamChat(MESSAGES, 'sys', 'interview'))
    expect(hoisted.claudeCalls).toEqual(['claude-sonnet-4-6']) // Fable STILL cooling → skipped
    expect(r2.text).toBe('claude-sonnet-4-6 says hi')

    // Past the full 30-min auth cooldown, Fable is tried FIRST again.
    hoisted.claudeCalls.length = 0
    vi.advanceTimersByTime(1_800_000)
    const r3 = await collect(streamChat(MESSAGES, 'sys', 'interview'))
    expect(hoisted.claudeCalls[0]).toBe('claude-fable-5')
    expect(r3.text).toBe('claude-fable-5 says hi')
  })
})

describe('all models in cooldown (Gemini chain)', () => {
  it('throws the terminal cooldown error without touching either model, and maps it to the "busy" user message', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    hoisted.geminiBehavior = () => Promise.reject(new Error('gemini 500 internal'))

    // Call 1: each chain model fails with a 2s inter-model delay between
    // attempts → all three cool down.
    const p1 = collect(streamChat(MESSAGES, 'sys', 'recall'))
    await vi.advanceTimersByTimeAsync(5_000)
    const r1 = await p1
    expect(r1.error?.message).toContain('gemini 500 internal')
    expect(hoisted.geminiCalls).toEqual(['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'])

    // Call 2, still inside every cooldown: terminal error, zero upstream calls.
    const r2 = await collect(streamChat(MESSAGES, 'sys', 'recall'))
    expect(r2.error?.message).toBe('All models are in cooldown')
    expect(hoisted.geminiCalls).toHaveLength(3) // unchanged
    expect(friendlyModelError(r2.error)).toBe('The AI is busy right now. Please try again in a moment.')
  })
})

describe('Gemini connect-race timeout', () => {
  it('times out a never-connecting primary at CONNECT_TIMEOUT_MS and serves from the backup with the degraded banner', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    hoisted.geminiBehavior = (model) =>
      model === 'gemini-3.5-flash'
        ? new Promise(() => {}) // connects never
        : geminiStream(['pro answer'])

    const p = collect(streamChat(MESSAGES, 'sys', 'recall'))
    // 45s connect race fires, then the 2s inter-model delay, then pro streams.
    await vi.advanceTimersByTimeAsync(50_000)
    const { text, models, error } = await p

    expect(error).toBeNull()
    expect(models).toEqual(['Gemini 2.5 Flash'])
    // The i>0 degraded-mode banner is part of the user-visible contract.
    expect(text).toBe('⚠️ *Primary model unavailable — using gemini-2.5-flash*\n\npro answer')
    expect(hoisted.geminiCalls).toEqual(['gemini-3.5-flash', 'gemini-2.5-flash'])
  })
})

describe('input contract + legacy wrapper', () => {
  it('rejects a history whose last message is not from the user', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    const { error } = await collect(streamChat(
      [{ id: '1', role: 'assistant', content: 'hi', timestamp: '' } as ChatMessage],
      'sys',
      'recall',
    ))
    expect(error?.message).toBe('Last message must be from the user')
  })

  it('streamGeminiChat (legacy) yields ONLY text — modelUsed events are filtered out', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    hoisted.geminiBehavior = () => geminiStream(['a', 'b'])
    const chunks: string[] = []
    for await (const c of streamGeminiChat(MESSAGES, 'sys', 'recall')) chunks.push(c)
    expect(chunks).toEqual(['a', 'b'])
    for (const c of chunks) expect(typeof c).toBe('string')
  })
})
