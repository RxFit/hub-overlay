import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ChatMessage } from '@/types'
import { streamChat, withIdleWatchdog, isRateLimitError, isAuthOrKeyError, friendlyModelError, __resetModelCooldownsForTest } from './gemini'

/* ════════════════════════════════════════════════════════════════════════════
   STRESS TEST — chat model-rotation engine (lib/gemini.ts streamChat)

   Every chat turn AND every left/right-panel inject flows through streamChat.
   Here it is hammered with: pre-stream failures, mid-stream failures (which must
   NOT duplicate output), auth fast-fail, per-model cooldown, idle stalls, and
   50-way concurrency. Claude + Gemini SDKs are mocked so failures/timing are
   injected deterministically.
   ════════════════════════════════════════════════════════════════════════════ */

process.env.GEMINI_API_KEY = 'test-key'

// Mutable behavior the mocks read at call time (hoisted above vi.mock).
const hoisted = vi.hoisted(() => ({
  claudeBehavior: null as null | ((model: string) => AsyncGenerator<string>),
  geminiBehavior: null as null | ((model: string) => { stream: AsyncIterable<{ text(): string }> }),
  claudeCalls: [] as string[],
  geminiCalls: [] as string[],
  // Consulted ONLY by the emergency cross-provider fallback. Default false =
  // pre-fallback behavior for every legacy test; the P0 suite flips it.
  claudeConfigured: false,
}))

vi.mock('@/lib/claude', () => ({
  CLAUDE_PRIMARY_MODEL: 'claude-fable-5',
  CLAUDE_BACKUP_MODEL: 'claude-sonnet-4-6',
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
          sendMessageStream: async (_content: string) => {
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

// ── helpers ──
const MESSAGES: ChatMessage[] = [{ id: '1', role: 'user', content: 'hello', timestamp: '' } as ChatMessage]

async function* claudeYield(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c
}
async function* claudeYieldThenThrow(chunks: string[], err: unknown): AsyncGenerator<string> {
  for (const c of chunks) yield c
  throw err
}
function geminiStream(chunks: string[]): { stream: AsyncIterable<{ text(): string }> } {
  return {
    stream: {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield { text: () => c }
      },
    },
  }
}
function geminiStreamThenThrow(chunks: string[], err: unknown): { stream: AsyncIterable<{ text(): string }> } {
  return {
    stream: {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield { text: () => c }
        throw err
      },
    },
  }
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

/* ──────────────────────────────────────────────────────────────────────────── */

describe('streamChat — Claude → Gemini rotation', () => {
  beforeEach(() => {
    hoisted.claudeCalls.length = 0
    hoisted.geminiCalls.length = 0
    hoisted.claudeBehavior = null
    hoisted.geminiBehavior = null
    hoisted.claudeConfigured = false
    // The per-model cooldown Map is a module-level singleton. Clear it before
    // each test so a cooldown recorded by one case can't leak into the next —
    // this is what made the suite flaky under the full parallel run. Reset
    // explicitly rather than via vi.resetModules()+dynamic import(), which is
    // fragile once fake timers are installed.
    __resetModelCooldownsForTest()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    __resetModelCooldownsForTest()
  })

  it('falls through Fable 5 → Sonnet 4.6 → Gemini Flash on pre-stream failures', async () => {
    hoisted.claudeBehavior = () => claudeYieldThenThrow([], new Error('claude down'))
    hoisted.geminiBehavior = () => geminiStream(['gem-answer'])

    const r = await collect(streamChat(MESSAGES, 'sys', 'interview', false))

    expect(hoisted.claudeCalls).toEqual(['claude-fable-5', 'claude-sonnet-4-6'])
    expect(r.models).toEqual(['Claude Fable 5', 'Claude Sonnet 4.6', 'Gemini 3.5 Flash'])
    expect(r.text).toContain('gem-answer')
    expect(r.error).toBeNull()
  })

  it('does NOT duplicate output when Fable 5 fails mid-stream (emittedAny guard)', async () => {
    hoisted.claudeBehavior = (model) =>
      model === 'claude-fable-5'
        ? claudeYieldThenThrow(['Hello '], new Error('socket reset'))
        : claudeYield(['SHOULD-NOT-RUN'])
    hoisted.geminiBehavior = () => geminiStream(['SHOULD-NOT-RUN'])

    const r = await collect(streamChat(MESSAGES, 'sys', 'interview', false))

    expect(r.text).toBe('Hello ')                 // partial preserved, NOT restarted
    expect(r.error).toBeInstanceOf(Error)         // error propagates
    expect(hoisted.claudeCalls).toEqual(['claude-fable-5']) // backup never tried
    expect(hoisted.geminiCalls).toEqual([])       // Gemini never tried
    expect(r.models).toEqual(['Claude Fable 5'])
  })

  it('fast-fails the whole Claude chain on an auth error and jumps to Gemini', async () => {
    hoisted.claudeBehavior = () => claudeYieldThenThrow([], Object.assign(new Error('401'), { claudeError: { type: 'auth' } }))
    hoisted.geminiBehavior = () => geminiStream(['gem'])

    const r = await collect(streamChat(MESSAGES, 'sys', 'interview', false))

    expect(hoisted.claudeCalls).toEqual(['claude-fable-5'])  // Sonnet skipped (shared key)
    expect(r.models).toEqual(['Claude Fable 5', 'Gemini 3.5 Flash'])
    expect(r.text).toBe('gem')
  })

  it('skips Claude entirely for the recall use case (panel-tap default)', async () => {
    hoisted.geminiBehavior = () => geminiStream(['recall-answer'])

    const r = await collect(streamChat(MESSAGES, 'sys', 'recall', false))

    expect(hoisted.claudeCalls).toEqual([])
    expect(r.models).toEqual(['Gemini 3.5 Flash'])
    expect(r.text).toBe('recall-answer')
  })

  it('does NOT fall back to Gemini Pro when Flash fails mid-stream', async () => {
    hoisted.geminiBehavior = (model) =>
      model === 'gemini-3.5-flash'
        ? geminiStreamThenThrow(['X'], new Error('flash stalled'))
        : geminiStream(['SHOULD-NOT-RUN'])

    const r = await collect(streamChat(MESSAGES, 'sys', 'recall', false))

    expect(r.text).toBe('X')
    expect(r.error).toBeInstanceOf(Error)
    expect(hoisted.geminiCalls).toEqual(['gemini-3.5-flash']) // rest of chain never tried
  })

  it('puts a failed model in cooldown so the next call skips it', async () => {
    hoisted.claudeBehavior = (model) =>
      model === 'claude-fable-5'
        ? claudeYieldThenThrow([], new Error('fable down')) // non-rate-limit → 5min cooldown
        : claudeYield(['sonnet-answer'])
    hoisted.geminiBehavior = () => geminiStream(['unused'])

    // Two sequential calls share the module-level cooldown Map (reset in beforeEach).
    const first = await collect(streamChat(MESSAGES, 'sys', 'interview', false))
    expect(hoisted.claudeCalls).toEqual(['claude-fable-5', 'claude-sonnet-4-6'])
    expect(first.text).toBe('sonnet-answer')

    hoisted.claudeCalls.length = 0
    const second = await collect(streamChat(MESSAGES, 'sys', 'interview', false))
    // Fable 5 is cooling down → skipped without even emitting its modelUsed badge
    expect(hoisted.claudeCalls).toEqual(['claude-sonnet-4-6'])
    expect(second.models).toEqual(['Claude Sonnet 4.6'])
    expect(second.text).toBe('sonnet-answer')
  })

  it('handles 50 concurrent streams with no cross-talk', async () => {
    let counter = 0
    hoisted.geminiBehavior = () => geminiStream([`tok${counter++}`])

    const results = await Promise.all(
      Array.from({ length: 50 }, () => collect(streamChat(MESSAGES, 'sys', 'recall', false))),
    )

    const texts = results.map(r => r.text)
    expect(new Set(texts).size).toBe(50)                 // every stream got its own answer
    results.forEach(r => {
      expect(r.error).toBeNull()
      expect(r.models).toEqual(['Gemini 3.5 Flash'])
    })
  })
})

describe('withIdleWatchdog — mid-stream stall protection', () => {
  function arrayIterator(values: string[]): AsyncIterator<string> {
    let i = 0
    return { next: () => Promise.resolve(i < values.length ? { done: false, value: values[i++] } : { done: true, value: undefined }) }
  }
  function stallingIterator(prompt: string[]) {
    let i = 0
    let returned = false
    return {
      next: () => (i < prompt.length ? Promise.resolve({ done: false, value: prompt[i++] }) : new Promise<IteratorResult<string>>(() => {})),
      return: () => { returned = true; return Promise.resolve({ done: true, value: undefined as unknown as string }) },
      wasReturned: () => returned,
    }
  }

  it('passes through all values from a prompt iterator', async () => {
    const out: string[] = []
    for await (const v of withIdleWatchdog(arrayIterator(['x', 'y', 'z']), 1_000, 't')) out.push(v)
    expect(out).toEqual(['x', 'y', 'z'])
  })

  it('fires after the idle period, invokes onTimeout, and tears down the upstream iterator', async () => {
    vi.useFakeTimers()
    try {
      const it = stallingIterator(['a'])
      const out: string[] = []
      let err: unknown
      const onTimeout = vi.fn()
      const run = (async () => { for await (const v of withIdleWatchdog(it, 30_000, 'test', onTimeout)) out.push(v) })().catch(e => { err = e })

      await vi.advanceTimersByTimeAsync(1)       // let 'a' flow through
      expect(out).toEqual(['a'])
      expect(onTimeout).not.toHaveBeenCalled()   // not yet — stream still within idle budget
      await vi.advanceTimersByTimeAsync(30_000)  // trip the watchdog on the stalled next()
      await run

      expect(err).toBeInstanceOf(Error)
      expect(String((err as Error).message)).toMatch(/idle watchdog/)
      expect(onTimeout).toHaveBeenCalledTimes(1) // telemetry hook fired on the real idle trigger
      expect(it.wasReturned()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tears down the upstream iterator when the consumer breaks early', async () => {
    const it = stallingIterator(['a', 'b'])
    for await (const _v of withIdleWatchdog(it, 1_000, 't')) break
    expect(it.wasReturned()).toBe(true)
  })
})

/* ──────────────────────────────────────────────────────────────────────────── */

describe('streamChat — observability telemetry', () => {
  type Emitted = Record<string, unknown> & { type: string }
  let events: Emitted[]
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    hoisted.claudeCalls.length = 0
    hoisted.geminiCalls.length = 0
    hoisted.claudeBehavior = null
    hoisted.geminiBehavior = null
    hoisted.claudeConfigured = false
    __resetModelCooldownsForTest()
    events = []
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = args[0]
      if (typeof line !== 'string') return
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed.type === 'string' && parsed.type.startsWith('ai_')) events.push(parsed)
      } catch { /* non-telemetry log line — ignore */ }
    })
  })
  afterEach(() => {
    logSpy.mockRestore()
    __resetModelCooldownsForTest()
  })

  const byType = (t: string) => events.filter(e => e.type === t)

  it('emits provider_selected → first_token → complete for a straight-through request', async () => {
    hoisted.geminiBehavior = () => geminiStream(['answer'])

    const r = await collect(streamChat(MESSAGES, 'sys', 'recall', false, 'req-ok'))
    expect(r.text).toBe('answer')

    // Exactly one selection, one first_token, one terminal complete, no error.
    expect(byType('ai_provider_selected')).toHaveLength(1)
    expect(byType('ai_first_token')).toHaveLength(1)
    expect(byType('ai_complete')).toHaveLength(1)
    expect(byType('ai_error')).toHaveLength(0)

    const complete = byType('ai_complete')[0]
    expect(complete).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash' })
    expect(typeof complete.ms).toBe('number')
    // Every event correlates on the threaded requestId.
    for (const e of events) expect(e.requestId).toBe('req-ok')
  })

  it('emits a fallback event when the primary (Fable 5) fails and rotates to the backup', async () => {
    // Fable 5 fails pre-stream → rotate to Sonnet 4.6, which succeeds.
    hoisted.claudeBehavior = (model) =>
      model === 'claude-fable-5'
        ? claudeYieldThenThrow([], new Error('fable down'))
        : claudeYield(['sonnet-answer'])

    const r = await collect(streamChat(MESSAGES, 'sys', 'interview', false, 'req-fb'))
    expect(r.text).toBe('sonnet-answer')

    // The fallback event fired on its REAL trigger (a genuine primary failure).
    const fallbacks = byType('ai_fallback')
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toMatchObject({ from: 'claude-fable-5', to: 'claude-sonnet-4-6', reason: 'error' })

    // Both attempts were announced; the terminal names the model that served.
    expect(byType('ai_provider_selected')).toHaveLength(2)
    expect(byType('ai_complete')[0]).toMatchObject({ provider: 'claude', model: 'claude-sonnet-4-6' })
  })

  it('emits a terminal error event (and no complete) when every provider fails', async () => {
    hoisted.claudeBehavior = () => claudeYieldThenThrow([], new Error('claude down'))
    hoisted.geminiBehavior = () => { throw new Error('gemini 500 internal error') }

    const r = await collect(streamChat(MESSAGES, 'sys', 'interview', false, 'req-err'))
    expect(r.error).toBeInstanceOf(Error)

    expect(byType('ai_complete')).toHaveLength(0)
    const errs = byType('ai_error')
    expect(errs).toHaveLength(1)
    expect(errs[0].requestId).toBe('req-err')
    expect(typeof errs[0].code).toBe('string')
  })
})

/* ──────────────────────────────────────────────────────────────────────────── */

describe('streamChat — P0 emergency cross-provider fallback (Gemini → Claude)', () => {
  /* One broken provider credential must not be a total AI outage: when the
     Gemini chain dies PRE-STREAM on default chat, a configured Claude chain
     serves the answer instead. Guards proven here: mid-stream failures never
     restart, the Claude chain is walked at most once per request, and with
     Claude unconfigured the pre-P0 behavior (incl. the exact user-facing
     string) is byte-identical. */
  type Emitted = Record<string, unknown> & { type: string }
  let events: Emitted[]
  let logSpy: ReturnType<typeof vi.spyOn>

  const AUTH_MSG = '[GoogleGenerativeAI Error]: [400 Bad Request] API key not valid. Please pass a valid API key.'

  beforeEach(() => {
    hoisted.claudeCalls.length = 0
    hoisted.geminiCalls.length = 0
    hoisted.claudeBehavior = null
    hoisted.geminiBehavior = null
    hoisted.claudeConfigured = false
    __resetModelCooldownsForTest()
    events = []
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = args[0]
      if (typeof line !== 'string') return
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed.type === 'string' && parsed.type.startsWith('ai_')) events.push(parsed)
      } catch { /* non-telemetry log line — ignore */ }
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    __resetModelCooldownsForTest()
  })

  const byType = (t: string) => events.filter(e => e.type === t)

  it('serves default chat from Claude when Gemini auth-fails pre-stream (reason: auth, subtle notice, badge switch)', async () => {
    hoisted.claudeConfigured = true
    hoisted.claudeBehavior = () => claudeYield(['claude answer'])
    hoisted.geminiBehavior = () => { throw new Error(AUTH_MSG) }

    const r = await collect(streamChat(MESSAGES, 'sys', 'recall', false, 'req-x'))

    expect(r.error).toBeNull()
    // Auth fast-fail: chain head only, rest never burned; then the Claude chain head.
    expect(hoisted.geminiCalls).toEqual(['gemini-3.5-flash'])
    expect(hoisted.claudeCalls).toEqual(['claude-fable-5'])
    expect(r.models).toEqual(['Claude Fable 5'])
    // The user sees the graceful degraded-mode note, then the real answer.
    expect(r.text).toBe('⚠️ *Primary model unavailable — using Claude Fable 5*\n\nclaude answer')

    const fallbacks = byType('ai_fallback')
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toMatchObject({ from: 'gemini-3.5-flash', to: 'claude-fable-5', reason: 'auth' })
    expect(byType('ai_complete')[0]).toMatchObject({ provider: 'claude', model: 'claude-fable-5' })
    expect(byType('ai_error')).toHaveLength(0)
  })

  it('falls back with reason "error" when the Gemini chain is exhausted pre-stream by non-auth failures', async () => {
    hoisted.claudeConfigured = true
    hoisted.claudeBehavior = () => claudeYield(['rescued'])
    hoisted.geminiBehavior = () => { throw new Error('gemini 500 internal') }

    vi.useFakeTimers()
    try {
      const p = collect(streamChat(MESSAGES, 'sys', 'recall', false, 'req-y'))
      await vi.advanceTimersByTimeAsync(5_000) // 3.5-flash fails → 2s delay → 2.5-flash fails → 2s delay → pro fails
      const r = await p

      expect(r.error).toBeNull()
      expect(hoisted.geminiCalls).toEqual(['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'])
      expect(r.text).toContain('rescued')
      // Intra-Gemini fallback event, then the cross-provider one.
      const fallbacks = byType('ai_fallback')
      expect(fallbacks.at(-1)).toMatchObject({ to: 'claude-fable-5', reason: 'error' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves the exact pre-P0 dead-end when Claude is NOT configured (fast-fail + "provider configuration" string)', async () => {
    hoisted.claudeConfigured = false
    hoisted.geminiBehavior = () => { throw new Error(AUTH_MSG) }

    const r = await collect(streamChat(MESSAGES, 'sys', 'recall', false))

    expect(r.text).toBe('')
    expect(hoisted.claudeCalls).toEqual([])            // Claude never walked
    expect(hoisted.geminiCalls).toEqual(['gemini-3.5-flash']) // auth fast-fail, no chain retry
    expect(r.error?.message).toBe(AUTH_MSG)            // original error surfaces
    expect(friendlyModelError(r.error)).toBe(
      'The AI service is temporarily unavailable (provider configuration). '
      + 'Please try again shortly — if it persists, contact an administrator.',
    )
  })

  it('loop guard: a Claude-first request whose Gemini leg auth-fails does NOT re-enter Claude', async () => {
    hoisted.claudeConfigured = true // config alone must not defeat the guard
    hoisted.claudeBehavior = () => claudeYieldThenThrow([], new Error('claude down'))
    hoisted.geminiBehavior = () => { throw new Error(AUTH_MSG) }

    const r = await collect(streamChat(MESSAGES, 'sys', 'interview', false))

    // Claude chain walked exactly once (both models), never a second time.
    expect(hoisted.claudeCalls).toEqual(['claude-fable-5', 'claude-sonnet-4-6'])
    expect(r.error?.message).toBe(AUTH_MSG) // the Gemini failure surfaces
  })

  it('mid-stream Gemini failure (text already on the wire) still propagates — no cross-provider restart', async () => {
    hoisted.claudeConfigured = true
    hoisted.claudeBehavior = () => claudeYield(['SHOULD-NOT-RUN'])
    hoisted.geminiBehavior = () => geminiStreamThenThrow(['X'], new Error(AUTH_MSG))

    const r = await collect(streamChat(MESSAGES, 'sys', 'recall', false))

    expect(r.text).toBe('X')                 // partial answer preserved, not restarted
    expect(r.error).toBeInstanceOf(Error)
    expect(hoisted.claudeCalls).toEqual([])  // Claude never engaged
  })

  it('both providers broken: throws the ORIGINAL Gemini error so the user message classifies the primary failure', async () => {
    hoisted.claudeConfigured = true
    hoisted.claudeBehavior = () => claudeYieldThenThrow([], new Error('anthropic exploded'))
    hoisted.geminiBehavior = () => { throw new Error(AUTH_MSG) }

    const r = await collect(streamChat(MESSAGES, 'sys', 'recall', false))

    // Claude WAS attempted (both models, pre-stream failures)...
    expect(hoisted.claudeCalls).toEqual(['claude-fable-5', 'claude-sonnet-4-6'])
    // ...but nothing reached the wire and the ORIGINAL Gemini error surfaced.
    expect(r.text).toBe('')
    expect(r.error?.message).toBe(AUTH_MSG)
    expect(friendlyModelError(r.error)).toContain('provider configuration')
    // Terminal telemetry reflects the primary failure class.
    expect(byType('ai_error')).toHaveLength(1)
    expect(byType('ai_error')[0]).toMatchObject({ code: 'auth' })
    expect(byType('ai_complete')).toHaveLength(0)
  })
})

describe('error classification', () => {
  it('isRateLimitError flags transient/throttle errors only', () => {
    for (const m of ['HTTP 429', 'rate limit hit', 'RESOURCE_EXHAUSTED', 'model overloaded', 'quota exceeded']) {
      expect(isRateLimitError(new Error(m))).toBe(true)
    }
    expect(isRateLimitError(new Error('500 internal error'))).toBe(false)
    expect(isRateLimitError(new Error('invalid api key'))).toBe(false)
  })

  it('isAuthOrKeyError flags credential failures (which doom every model)', () => {
    for (const m of ['HTTP 401 Unauthorized', 'status 403', 'invalid api key', 'permission denied', 'billing disabled']) {
      expect(isAuthOrKeyError(new Error(m))).toBe(true)
    }
    expect(isAuthOrKeyError(new Error('429 rate limit'))).toBe(false)
    expect(isAuthOrKeyError(new Error('Gemini stream timeout'))).toBe(false)
  })
})

describe('friendlyModelError — user-facing message mapping', () => {
  it('maps auth/key/config failures to the config message', () => {
    const authMsg = 'The AI service is temporarily unavailable (provider configuration). '
      + 'Please try again shortly — if it persists, contact an administrator.'
    for (const m of [
      '[GoogleGenerativeAI Error]: [400 Bad Request] API key not valid. Please pass a valid API key.',
      'HTTP 401 Unauthorized',
      'status 403',
      'permission denied',
      'billing disabled',
    ]) {
      expect(friendlyModelError(new Error(m))).toBe(authMsg)
    }
  })

  it('maps rate-limit / busy / cooldown failures to the busy message', () => {
    const busyMsg = 'The AI is busy right now. Please try again in a moment.'
    for (const m of ['HTTP 429', 'model overloaded', 'quota exceeded', 'All models are in cooldown']) {
      expect(friendlyModelError(new Error(m))).toBe(busyMsg)
    }
  })

  it('maps unknown/generic failures to the retry message', () => {
    const retryMsg = "The AI couldn't complete that response. Please try again."
    for (const m of ['Gemini stream timeout (gemini-2.5-pro)', '500 internal error', 'something exploded']) {
      expect(friendlyModelError(new Error(m))).toBe(retryMsg)
    }
    // Non-Error inputs are handled too.
    expect(friendlyModelError('boom')).toBe(retryMsg)
    expect(friendlyModelError(undefined)).toBe(retryMsg)
  })

  it('auth takes precedence over rate-limit when both could match', () => {
    // A message containing both an auth and a rate-limit signal resolves to config.
    const out = friendlyModelError(new Error('401 unauthorized — also rate limit'))
    expect(out).toContain('provider configuration')
  })

  it('never leaks raw provider internals into the output', () => {
    const leaky = '[GoogleGenerativeAI Error]: Error fetching from '
      + 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent: '
      + '[400 Bad Request] API key not valid. Please pass a valid API key.'
    const out = friendlyModelError(new Error(leaky))
    for (const needle of [
      'GoogleGenerativeAI', 'generativelanguage', 'gemini-2.5-pro',
      'streamGenerateContent', '400', 'API key not valid', 'https',
    ]) {
      expect(out).not.toContain(needle)
    }
  })
})
