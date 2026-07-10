import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ChatMessage } from '@/types'
import { streamChat, __resetModelCooldownsForTest } from './gemini'

/* ════════════════════════════════════════════════════════════════════════════
   Abort / cancellation hardening.

   FIX3 — the Gemini connect race now aborts the upstream request (via the SDK's
   SingleRequestOptions.signal) when the CONNECT_TIMEOUT_MS ceiling trips, and
   the abandoned connect promise's eventual rejection is swallowed so it can't
   surface as an unhandledRejection (mirrors Claude's AbortController).

   FIX4 — a client abort (req.signal) threaded into streamChat stops the
   rotation cooperatively: it does not start the next model attempt, and it
   stops mid-stream — WITHOUT restarting the answer (no-duplicate discipline)
   and without surfacing a user-visible error.

   The SDK + Claude client are stubbed so the abort signal and timing are
   observed deterministically under fake timers.
   ════════════════════════════════════════════════════════════════════════════ */

const hoisted = vi.hoisted(() => ({
  geminiBehavior: null as null | ((model: string, signal?: AbortSignal) => Promise<{ stream: AsyncIterable<{ text(): string }> }>),
  geminiCalls: [] as string[],
  capturedSignals: [] as (AbortSignal | undefined)[],
}))

vi.mock('@/lib/claude', () => ({
  isClaudeConfigured: () => false,
  streamClaudeChat: () => { throw new Error('claude should not be used in these tests') },
}))

vi.mock('@google/generative-ai', () => {
  class GoogleGenerativeAI {
    getGenerativeModel({ model }: { model: string }) {
      return {
        startChat: () => ({
          sendMessageStream: (_content: string, opts?: { signal?: AbortSignal }) => {
            hoisted.geminiCalls.push(model)
            hoisted.capturedSignals.push(opts?.signal)
            if (!hoisted.geminiBehavior) throw new Error('geminiBehavior not set')
            return hoisted.geminiBehavior(model, opts?.signal)
          },
        }),
      }
    }
  }
  return { GoogleGenerativeAI }
})

const MESSAGES: ChatMessage[] = [{ id: '1', role: 'user', content: 'hello', timestamp: '' } as ChatMessage]

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
  process.env.GEMINI_API_KEY = 'test-key'
  hoisted.geminiBehavior = null
  hoisted.geminiCalls.length = 0
  hoisted.capturedSignals.length = 0
  __resetModelCooldownsForTest()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  __resetModelCooldownsForTest()
})

describe('Gemini connect-race abort (P2 FIX3)', () => {
  it('passes an abort signal to the SDK and aborts the upstream request on connect timeout — then serves the backup', async () => {
    vi.useFakeTimers()
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      // Flash "connects" only as a promise that rejects when ITS signal aborts —
      // proving the connect timeout actually reaches the upstream request.
      hoisted.geminiBehavior = (model, signal) => {
        if (model === 'gemini-2.5-flash') {
          return new Promise((_, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('upstream aborted')))
          })
        }
        return geminiStream(['pro answer'])
      }

      const p = collect(streamChat(MESSAGES, 'sys', 'recall'))
      // 45s connect race trips → flash upstream aborted → 2s delay → pro streams.
      await vi.advanceTimersByTimeAsync(50_000)
      const { text, models, error } = await p

      expect(error).toBeNull()
      // FIX3: a real AbortSignal was handed to the SDK for the flash attempt...
      expect(hoisted.capturedSignals[0]).toBeInstanceOf(AbortSignal)
      // ...and the connect timeout aborted it (true upstream abort, not just a
      // stopped wait).
      expect(hoisted.capturedSignals[0]?.aborted).toBe(true)
      // The backup still served with the degraded banner (rotation intact).
      expect(models).toEqual(['Gemini 2.5 Pro'])
      expect(text).toBe('⚠️ *Primary model unavailable — using gemini-2.5-pro*\n\npro answer')

      // The abandoned flash promise's rejection was swallowed — no leak.
      await vi.advanceTimersByTimeAsync(0)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('client-abort cooperative cancellation (P2 FIX4)', () => {
  it('does not start ANY model attempt when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    hoisted.geminiBehavior = () => geminiStream(['SHOULD-NOT-RUN'])

    const r = await collect(streamChat(MESSAGES, 'sys', 'recall', false, 'req-a', ctrl.signal))

    expect(r.text).toBe('')
    expect(r.error).toBeNull()          // clean stop, NOT an error
    expect(hoisted.geminiCalls).toEqual([]) // rotation never attempted a model
  })

  it('stops mid-stream on abort WITHOUT restarting the answer or surfacing an error', async () => {
    const ctrl = new AbortController()
    // Emit one chunk, then the client aborts; the next chunk must NOT be yielded.
    hoisted.geminiBehavior = () => Promise.resolve({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { text: () => 'first ' }
          ctrl.abort()
          yield { text: () => 'SHOULD-NOT-APPEAR' }
        },
      },
    })

    const r = await collect(streamChat(MESSAGES, 'sys', 'recall', false, 'req-b', ctrl.signal))

    expect(r.text).toBe('first ')       // partial preserved, NOT restarted/duplicated
    expect(r.error).toBeNull()          // abort is a clean stop, not a user error
    expect(hoisted.geminiCalls).toEqual(['gemini-2.5-flash']) // no rotation to pro
  })
})
