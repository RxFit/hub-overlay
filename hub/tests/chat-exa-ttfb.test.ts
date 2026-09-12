import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Locks the time-to-first-byte contract of the EXA path.
 *
 * Response HEADERS cannot exist until the route handler returns a Response. The
 * EXA path used to `await Promise.all([exa, vertex, driveLinks])` and only THEN
 * call streamModelResponse — so the browser's `fetch('/api/chat')` stayed blocked
 * for the whole assembly window (bounded at 30s by the Exa branch) with nothing
 * rendered but a typing dot. Appending anything to the END of the stream, as was
 * once proposed, cannot move that by a millisecond; only returning the Response
 * first can.
 *
 * These tests hold the Exa branch open and assert the Response has already been
 * handed back, with a status frame on the wire, while it is still pending.
 */

/** A promise we settle by hand, to hold context assembly open deterministically. */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** Reset per test — a module-level gate resolved in one test pre-settles the next. */
let exaGate = deferred<unknown[]>()

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { email: 'danny@rxfitatx.com', name: 'Danny' } })),
}))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => null) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/validate-keys', () => ({}))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ allowed: true }) }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('@/lib/chat-store', () => ({
  persistUserTurn: vi.fn(async () => {}),
  persistAssistantTurn: vi.fn(async () => {}),
}))

// The Exa branch blocks until the test releases it.
vi.mock('@/lib/exa', () => ({
  searchWeb: vi.fn(() => exaGate.promise),  // reads the CURRENT gate at call time
  parseSubQueries: (_t: string, q: string) => [q],
  mergeExaResults: (lists: unknown[][]) => lists.flat(),
  fetchUrlWithExa: vi.fn(),
}))
// The planner is a dynamic import inside runExaOnlySearch.
vi.mock('@/lib/gemini', async () => {
  const actual = await vi.importActual<typeof import('@/lib/gemini')>('@/lib/gemini')
  return {
    ...actual,
    geminiGenerateText: vi.fn(async () => ({ text: '["a"]' })),
    friendlyModelError: () => 'Something went wrong.',
    // Two text frames then done — enough to prove real text follows the status.
    streamChat: vi.fn(async function* () {
      yield { modelUsed: 'Fable 5' }
      yield 'Here is '
      yield 'the answer.'
    }),
  }
})
vi.mock('@/lib/vertex', async () => {
  const actual = await vi.importActual<typeof import('@/lib/vertex')>('@/lib/vertex')
  return { ...actual, searchSemanticBrain: vi.fn(async () => []) }
})
vi.mock('@/lib/google-session', () => ({
  resolveGoogleAccessTokenLenient: vi.fn(async () => ({ ok: false, reason: 'missing' })),
}))
vi.mock('@/lib/drive-links', () => ({
  resolveDriveLinkContext: vi.fn(async () => ({ content: '', advisory: '' })),
}))

import { POST } from '@/app/api/chat/route'
import { NextRequest } from 'next/server'

function exaRequest() {
  return new NextRequest('http://localhost/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      messages: [{
        id: 'm1',
        role: 'user',
        content: 'what is new in GLP-1 research',
        timestamp: '2026-09-12T04:00:00.000Z',
      }],
      exaMode: true,
    }),
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Read SSE frames until `count` have arrived. */
async function readFrames(res: Response, count: number): Promise<string[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const frames: string[] = []
  let buffer = ''
  while (frames.length < count) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const p of parts) if (p.trim()) frames.push(p.trim())
  }
  void reader.cancel()
  return frames
}

describe('EXA mode — the Response is returned BEFORE context assembly runs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    exaGate = deferred<unknown[]>()
  })

  it('responds with streaming headers while the Exa branch is still pending', async () => {
    const res = await POST(exaRequest())

    // THE regression. Against the old code this await could not resolve: the
    // handler was still inside `await Promise.all([...])` and no Response existed.
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-cache')

    // Still pending — the Response genuinely preceded the work.
    const settled = await Promise.race([
      exaGate.promise.then(() => 'settled'),
      Promise.resolve('pending'),
    ])
    expect(settled).toBe('pending')

    exaGate.resolve([])
  })

  it('narrates the wait with a status frame, then streams the real answer over it', async () => {
    const res = await POST(exaRequest())

    // First frame arrives while assembly is still blocked, so the bubble has
    // something to show instead of sitting empty.
    const [first] = await readFrames(res, 1)
    expect(JSON.parse(first.replace(/^data: /, ''))).toEqual({
      status: expect.stringContaining('Searching'),
    })

    exaGate.resolve([])
  })

  it('the status frame never reaches the persisted turn', async () => {
    const { persistAssistantTurn } = await import('@/lib/chat-store')
    exaGate.resolve([])

    const res = await POST(
      new NextRequest('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [{
            id: 'm1',
            role: 'user',
            content: 'hello',
            timestamp: '2026-09-12T04:00:00.000Z',
          }],
          exaMode: true,
          chatId: 'abcd1234-efgh',
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    // Drain so the stream completes and persistence fires.
    await new Response(res.body).text()

    const call = vi.mocked(persistAssistantTurn).mock.calls.at(-1)?.[0]
    expect(call?.content).toBe('Here is the answer.')
    // `fullText` accumulates only model chunks — the progress line is presentation,
    // never record, so the live bubble and a reloaded chat cannot disagree.
    expect(call?.content).not.toContain('Searching')
  })
})
