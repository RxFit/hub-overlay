import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * lib/chat-store.ts — server-side conversation persistence.
 *
 * Locks the three contracts:
 *  - OWNERSHIP: a chat id belonging to another user is silently dropped on
 *    write and reads as null (no existence oracle).
 *  - IDEMPOTENCE: user turns insert with the client message id and
 *    onConflictDoNothing, so a retried POST cannot double-insert.
 *  - BEST-EFFORT: write failures are swallowed into an ai_error telemetry
 *    line; the caller's request path never sees a throw.
 *
 * The db mock is a small chainable: every query-builder method returns the
 * chain; awaiting it resolves `state.selectResult` for selects and undefined
 * for writes. Inserted/updated values are captured for assertions.
 */

const { state, emitMock } = vi.hoisted(() => {
  const state = {
    selectResults: [] as unknown[][],   // shifted per select() call
    inserts: [] as { table: unknown; values: unknown; conflict: boolean }[],
    updates: [] as { table: unknown; set: unknown }[],
    failNextWrite: null as string | null,
  }
  return { state, emitMock: vi.fn() }
})

vi.mock('./db', () => {
  function makeThenable(result: unknown): Record<string, unknown> {
    const chain: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'orderBy', 'limit']) {
      chain[m] = () => chain
    }
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject)
    return chain
  }
  return {
    db: {
      select: () => makeThenable(state.selectResults.shift() ?? []),
      insert: (table: unknown) => ({
        values: (values: unknown) => {
          if (state.failNextWrite) {
            const msg = state.failNextWrite
            state.failNextWrite = null
            const rejected = Promise.reject(new Error(msg))
            return {
              onConflictDoNothing: () => rejected,
              then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => rejected.then(res, rej),
            }
          }
          state.inserts.push({ table, values, conflict: false })
          const entry = state.inserts[state.inserts.length - 1]
          const done = Promise.resolve(undefined)
          return {
            onConflictDoNothing: () => {
              entry.conflict = true
              return done
            },
            then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => done.then(res, rej),
          }
        },
      }),
      update: (table: unknown) => ({
        set: (set: unknown) => {
          state.updates.push({ table, set })
          return { where: () => Promise.resolve(undefined) }
        },
      }),
    },
  }
})
vi.mock('./observability', () => ({ emit: emitMock }))

import { deriveChatTitle, persistUserTurn, persistAssistantTurn, getChatMessages } from './chat-store'
import { chats, chatMessages } from './schema'

beforeEach(() => {
  state.selectResults = []
  state.inserts = []
  state.updates = []
  state.failNextWrite = null
  emitMock.mockReset()
})

describe('deriveChatTitle', () => {
  it('collapses whitespace and bounds length', () => {
    expect(deriveChatTitle('  what\n\nis   our  Q3 plan? ')).toBe('what is our Q3 plan?')
    expect(deriveChatTitle('x'.repeat(200))!.length).toBe(81) // 80 + ellipsis
    expect(deriveChatTitle('   ')).toBeNull()
  })
})

describe('persistUserTurn', () => {
  it('creates the chat with a derived title on first sight, then appends idempotently', async () => {
    state.selectResults = [[]] // chatOwner: no row → new chat
    await persistUserTurn({ chatId: 'chat-uuid-1', userEmail: 'Danny@RxFitATX.com', messageId: 'msg-1', content: 'hello world' })

    expect(state.inserts).toHaveLength(2)
    const chatInsert = state.inserts[0]
    expect(chatInsert.table).toBe(chats)
    expect(chatInsert.values).toMatchObject({ id: 'chat-uuid-1', userEmail: 'danny@rxfitatx.com', title: 'hello world' })
    const msgInsert = state.inserts[1]
    expect(msgInsert.table).toBe(chatMessages)
    expect(msgInsert.values).toMatchObject({ id: 'msg-1', chatId: 'chat-uuid-1', role: 'user', content: 'hello world' })
    expect(msgInsert.conflict).toBe(true) // ON CONFLICT DO NOTHING — retry-safe
  })

  it('bumps updated_at instead of re-creating an owned chat', async () => {
    state.selectResults = [[{ userEmail: 'danny@rxfitatx.com' }]]
    await persistUserTurn({ chatId: 'chat-uuid-1', userEmail: 'danny@rxfitatx.com', content: 'follow-up' })
    expect(state.updates).toHaveLength(1)
    expect(state.inserts).toHaveLength(1) // just the message
    expect(state.inserts[0].table).toBe(chatMessages)
  })

  it("DROPS a write against someone else's chat id — no insert, no error", async () => {
    state.selectResults = [[{ userEmail: 'other@rxfitatx.com' }]]
    await persistUserTurn({ chatId: 'stolen-uuid', userEmail: 'danny@rxfitatx.com', content: 'hi' })
    expect(state.inserts).toHaveLength(0)
    expect(state.updates).toHaveLength(0)
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('swallows db failures into ai_error telemetry — never throws', async () => {
    state.selectResults = [[]]
    state.failNextWrite = 'connection refused'
    await expect(
      persistUserTurn({ chatId: 'chat-uuid-1', userEmail: 'danny@rxfitatx.com', content: 'hi' }),
    ).resolves.toBeUndefined()
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'ai_error', code: 'chat_persist_failed' }))
  })
})

describe('persistAssistantTurn', () => {
  it('appends under an owned chat with the serving model badge', async () => {
    state.selectResults = [[{ userEmail: 'danny@rxfitatx.com' }]]
    await persistAssistantTurn({ chatId: 'chat-uuid-1', userEmail: 'danny@rxfitatx.com', content: 'the answer', model: 'Antigravity' })
    expect(state.inserts).toHaveLength(1)
    expect(state.inserts[0].values).toMatchObject({ chatId: 'chat-uuid-1', role: 'assistant', content: 'the answer', model: 'Antigravity' })
    expect(state.updates).toHaveLength(1) // updated_at bump
  })

  it('drops the write when the chat is missing or foreign', async () => {
    state.selectResults = [[]]
    await persistAssistantTurn({ chatId: 'nope', userEmail: 'danny@rxfitatx.com', content: 'orphan' })
    expect(state.inserts).toHaveLength(0)
  })
})

describe('getChatMessages', () => {
  it('returns null (not empty) for a foreign or missing chat — no existence oracle', async () => {
    state.selectResults = [[]] // ownership check finds nothing
    expect(await getChatMessages('foreign-id', 'danny@rxfitatx.com')).toBeNull()
  })

  it('returns ordered messages for an owned chat', async () => {
    state.selectResults = [
      [{ id: 'chat-uuid-1' }], // ownership check passes
      [
        { id: 'm1', role: 'user', content: 'q', model: null, createdAt: new Date('2026-08-14T00:00:00Z') },
        { id: 'm2', role: 'assistant', content: 'a', model: 'Antigravity', createdAt: new Date('2026-08-14T00:00:05Z') },
      ],
    ]
    const messages = await getChatMessages('chat-uuid-1', 'danny@rxfitatx.com')
    expect(messages).toHaveLength(2)
    expect(messages![0]).toMatchObject({ id: 'm1', role: 'user', content: 'q' })
    expect(messages![1]).toMatchObject({ id: 'm2', role: 'assistant', model: 'Antigravity' })
    expect(messages![1].createdAt).toBe('2026-08-14T00:00:05.000Z')
  })
})
