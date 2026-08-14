import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ChatMessage } from '@/types'
import { streamChat, __resetModelCooldownsForTest } from './gemini'
import { buildAgyPrompt, agyChatTimeoutMs, __resetAgyChatCooldownForTest } from './agy-chat'

/* ════════════════════════════════════════════════════════════════════════════
   Phase 2 (agy allotment-first chat) — the rotation contract:
   flag off ⇒ byte-identical to pre-Phase-2; flag on ⇒ agy serves non-EXA turns
   and ANY failure falls through to Gemini with the wire untouched. Same
   deterministic harness as gemini-rotation.test.ts (providers stubbed, fake
   timers drive cooldown clocks), with the agy CLI layer (@/lib/agy) stubbed
   at the same seam agy-chat consumes it.
   ════════════════════════════════════════════════════════════════════════════ */

const hoisted = vi.hoisted(() => ({
  claudeBehavior: null as null | ((model: string) => AsyncGenerator<string>),
  claudeCalls: [] as string[],
  geminiBehavior: null as null | ((model: string) => Promise<{ stream: AsyncIterable<{ text(): string }> }>),
  geminiCalls: [] as string[],
  agyBehavior: null as null | ((prompt: string) => Promise<{ text: string }>),
  agyCalls: [] as { prompt: string; timeoutMs?: number }[],
  agyConfigured: true,
  agyBinaryReady: true,
  warmCalls: 0,
  runCalls: [] as Record<string, unknown>[],
}))

// The runs ledger is stubbed at the same seam agy-chat consumes it: capture
// the input, resolve immediately (the real recordAiRun is best-effort/no-throw).
vi.mock('@/lib/runs', () => ({
  recordAiRun: (input: Record<string, unknown>) => {
    hoisted.runCalls.push(input)
    return Promise.resolve()
  },
}))

vi.mock('@/lib/agy', () => ({
  isAgyConfigured: () => hoisted.agyConfigured,
  isAgyBinaryReady: () => hoisted.agyBinaryReady,
  warmAgyBinary: () => {
    hoisted.warmCalls += 1
  },
  agyErrorType: (err: unknown) => (err as { agyError?: { type: string } })?.agyError?.type ?? 'unknown',
  truncateAgyError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  agyGenerateText: (prompt: string, opts?: { timeoutMs?: number }) => {
    hoisted.agyCalls.push({ prompt, timeoutMs: opts?.timeoutMs })
    if (!hoisted.agyBehavior) throw new Error('agyBehavior not set')
    return hoisted.agyBehavior(prompt)
  },
}))

vi.mock('@/lib/claude', () => ({
  isClaudeConfigured: () => false,
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
function agyFailure(type: string): Promise<{ text: string }> {
  return Promise.reject(Object.assign(new Error(`agy ${type}`), { agyError: { type, message: `agy ${type}` } }))
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

const SAVED_ENV = {
  AGY_CHAT_ENABLED: process.env.AGY_CHAT_ENABLED,
  AGY_CHAT_TIMEOUT_MS: process.env.AGY_CHAT_TIMEOUT_MS,
}

beforeEach(() => {
  hoisted.claudeBehavior = null
  hoisted.geminiBehavior = null
  hoisted.agyBehavior = null
  hoisted.claudeCalls.length = 0
  hoisted.geminiCalls.length = 0
  hoisted.agyCalls.length = 0
  hoisted.agyConfigured = true
  hoisted.agyBinaryReady = true
  hoisted.warmCalls = 0
  hoisted.runCalls.length = 0
  process.env.GEMINI_API_KEY = 'test-key'
  delete process.env.AGY_CHAT_ENABLED
  delete process.env.AGY_CHAT_TIMEOUT_MS
  __resetModelCooldownsForTest()
  __resetAgyChatCooldownForTest()
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  __resetModelCooldownsForTest()
  __resetAgyChatCooldownForTest()
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k as keyof typeof SAVED_ENV]
    else process.env[k as keyof typeof SAVED_ENV] = v
  }
})

describe('buildAgyPrompt', () => {
  it('leads with the system text, labels roles, and pins the reply instruction', () => {
    const prompt = buildAgyPrompt(
      [
        { id: '1', role: 'user', content: 'first question', timestamp: '' } as ChatMessage,
        { id: '2', role: 'assistant', content: 'earlier answer', timestamp: '' } as ChatMessage,
        { id: '3', role: 'user', content: 'follow-up', timestamp: '' } as ChatMessage,
      ],
      'SYSTEM RULES',
    )
    expect(prompt.startsWith('SYSTEM RULES\n\n')).toBe(true)
    expect(prompt).toContain('User: first question')
    expect(prompt).toContain('Assistant: earlier answer')
    expect(prompt).toContain('User: follow-up')
    expect(prompt.indexOf('User: first question')).toBeLessThan(prompt.indexOf('Assistant: earlier answer'))
    expect(prompt.trimEnd().endsWith('Output ONLY the reply text.')).toBe(true)
  })
})

describe('agyChatTimeoutMs', () => {
  it('defaults to the 45s per-attempt rung and clamps overrides into [5s, 90s]', () => {
    expect(agyChatTimeoutMs()).toBe(45_000)
    process.env.AGY_CHAT_TIMEOUT_MS = '60000'
    expect(agyChatTimeoutMs()).toBe(60_000)
    process.env.AGY_CHAT_TIMEOUT_MS = '1000'
    expect(agyChatTimeoutMs()).toBe(5_000)
    process.env.AGY_CHAT_TIMEOUT_MS = '600000'
    expect(agyChatTimeoutMs()).toBe(90_000)
    process.env.AGY_CHAT_TIMEOUT_MS = 'nonsense'
    expect(agyChatTimeoutMs()).toBe(45_000)
  })
})

describe('flag off (the default)', () => {
  it('never touches agy — Gemini serves exactly as before Phase 2', async () => {
    hoisted.geminiBehavior = () => geminiStream(['gem answer'])
    const { text, models, error } = await collect(streamChat(MESSAGES, 'sys', 'recall'))
    expect(error).toBeNull()
    expect(text).toBe('gem answer')
    expect(models).toEqual(['Gemini 3.5 Flash'])
    expect(hoisted.agyCalls).toHaveLength(0)
    expect(hoisted.warmCalls).toBe(0)
  })
})

describe('flag on — allotment serves', () => {
  it('answers from agy with the badge, zero Gemini calls, and the bounded timeout', async () => {
    process.env.AGY_CHAT_ENABLED = 'true'
    hoisted.agyBehavior = () => Promise.resolve({ text: 'allotment answer' })

    const { text, models, error } = await collect(streamChat(MESSAGES, 'sys prompt', 'recall'))
    expect(error).toBeNull()
    expect(text).toBe('allotment answer')
    expect(models).toEqual(['Antigravity'])
    expect(hoisted.geminiCalls).toHaveLength(0)
    expect(hoisted.agyCalls).toHaveLength(1)
    expect(hoisted.agyCalls[0].timeoutMs).toBe(45_000)
    // The flattened prompt carries the system text and the user turn.
    expect(hoisted.agyCalls[0].prompt).toContain('sys prompt')
    expect(hoisted.agyCalls[0].prompt).toContain('User: hello')
  })

  it("accepts '1' as the flag value", async () => {
    process.env.AGY_CHAT_ENABLED = '1'
    hoisted.agyBehavior = () => Promise.resolve({ text: 'ok' })
    const { text } = await collect(streamChat(MESSAGES, 'sys', 'recall'))
    expect(text).toBe('ok')
  })

  it('is not attempted when no agy credential is configured', async () => {
    process.env.AGY_CHAT_ENABLED = 'true'
    hoisted.agyConfigured = false
    hoisted.geminiBehavior = () => geminiStream(['gem'])
    const { text } = await collect(streamChat(MESSAGES, 'sys', 'recall'))
    expect(text).toBe('gem')
    expect(hoisted.agyCalls).toHaveLength(0)
  })
})

describe('flag on — failure falls through to Gemini', () => {
  it('serves from Gemini with the wire untouched, then skips agy during the 5-min cooldown and retries after it', async () => {
    process.env.AGY_CHAT_ENABLED = 'true'
    hoisted.agyBehavior = () => agyFailure('empty')
    hoisted.geminiBehavior = () => geminiStream(['gem rescue'])

    // Call 1: agy fails pre-wire → Gemini answers cleanly (badge superseded).
    const r1 = await collect(streamChat(MESSAGES, 'sys', 'recall'))
    expect(r1.error).toBeNull()
    expect(r1.text).toBe('gem rescue')
    expect(r1.models).toEqual(['Antigravity', 'Gemini 3.5 Flash'])
    expect(hoisted.agyCalls).toHaveLength(1)

    // Call 2, inside the 5-min real-failure cooldown: agy is not attempted.
    const r2 = await collect(streamChat(MESSAGES, 'sys', 'recall'))
    expect(r2.text).toBe('gem rescue')
    expect(hoisted.agyCalls).toHaveLength(1)

    // Past the cooldown, agy is tried first again.
    hoisted.agyBehavior = () => Promise.resolve({ text: 'allotment back' })
    vi.advanceTimersByTime(301_000)
    const r3 = await collect(streamChat(MESSAGES, 'sys', 'recall'))
    expect(r3.text).toBe('allotment back')
    expect(hoisted.agyCalls).toHaveLength(2)
  })

  it('gives an auth-class failure the 30-min tier, not the 5-min tier', async () => {
    process.env.AGY_CHAT_ENABLED = 'true'
    hoisted.agyBehavior = () => agyFailure('auth')
    hoisted.geminiBehavior = () => geminiStream(['gem'])

    await collect(streamChat(MESSAGES, 'sys', 'recall'))
    expect(hoisted.agyCalls).toHaveLength(1)

    // Past the 5-min tier but inside the 30-min auth tier: still skipped.
    vi.advanceTimersByTime(301_000)
    await collect(streamChat(MESSAGES, 'sys', 'recall'))
    expect(hoisted.agyCalls).toHaveLength(1)

    // Past the auth tier: attempted again.
    vi.advanceTimersByTime(1_800_000)
    await collect(streamChat(MESSAGES, 'sys', 'recall'))
    expect(hoisted.agyCalls).toHaveLength(2)
  })
})

describe('runs ledger (Phase 2 accountability)', () => {
  it('a served turn records one ok row: engine, source, prompt provenance, request correlation', async () => {
    process.env.AGY_CHAT_ENABLED = 'true'
    hoisted.agyBehavior = () =>
      Promise.resolve({ text: 'allotment answer', model: 'gemini-3-pro', latencyMs: 900, usage: { outputTokens: 5 } })

    await collect(streamChat(MESSAGES, 'sys prompt', 'recall'))
    expect(hoisted.runCalls).toHaveLength(1)
    const run = hoisted.runCalls[0]
    expect(run.engine).toBe('agy')
    expect(run.source).toBe('chat')
    expect(run.status).toBe('ok')
    expect(run.model).toBe('gemini-3-pro')
    expect(run.latencyMs).toBe(900)
    expect(run.usage).toEqual({ outputTokens: 5 })
    // The prompt is passed for fingerprinting — the module under mock never
    // stores it, and the row carries the same requestId the telemetry does.
    expect(run.prompt).toContain('User: hello')
    expect(typeof run.requestId).toBe('string')
  })

  it('a failed attempt records one error row with the typed class, then the Gemini rescue is not double-counted', async () => {
    process.env.AGY_CHAT_ENABLED = 'true'
    hoisted.agyBehavior = () => agyFailure('empty')
    hoisted.geminiBehavior = () => geminiStream(['gem rescue'])

    await collect(streamChat(MESSAGES, 'sys', 'recall'))
    expect(hoisted.runCalls).toHaveLength(1)
    const run = hoisted.runCalls[0]
    expect(run.status).toBe('error')
    expect(run.errorClass).toBe('empty')
    expect(run.engine).toBe('agy')
    expect(run.source).toBe('chat')
  })

  it('no ledger row when agy is not attempted (flag off)', async () => {
    hoisted.geminiBehavior = () => geminiStream(['gem'])
    await collect(streamChat(MESSAGES, 'sys', 'recall'))
    expect(hoisted.runCalls).toHaveLength(0)
  })
})

describe('cold instance (binary not provisioned)', () => {
  it('warms in the background and serves this turn from Gemini without attempting agy', async () => {
    process.env.AGY_CHAT_ENABLED = 'true'
    hoisted.agyBinaryReady = false
    hoisted.geminiBehavior = () => geminiStream(['gem while warming'])

    const { text, models } = await collect(streamChat(MESSAGES, 'sys', 'recall'))
    expect(text).toBe('gem while warming')
    expect(models).toEqual(['Gemini 3.5 Flash'])
    expect(hoisted.warmCalls).toBe(1)
    expect(hoisted.agyCalls).toHaveLength(0)
  })
})

describe('EXA mode exclusion', () => {
  it('never routes an exa_search turn to agy, even with the flag on — Fable 5 serves', async () => {
    process.env.AGY_CHAT_ENABLED = 'true'
    hoisted.claudeBehavior = (model) => claudeYield([`${model} research`])

    const { text, models } = await collect(streamChat(MESSAGES, 'sys', 'exa_search'))
    expect(text).toBe('claude-fable-5 research')
    expect(models).toEqual(['Claude Fable 5'])
    expect(hoisted.agyCalls).toHaveLength(0)
    expect(hoisted.warmCalls).toBe(0)
  })
})
