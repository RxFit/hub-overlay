import { describe, it, expect } from 'vitest'
import { boundHistory, MAX_HISTORY_MESSAGES } from './history-window'

type Msg = { role: string; content: string }

const make = (n: number): Msg[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `m${i}`,
  }))

describe('boundHistory', () => {
  it('returns the identical array (same order, same reference) when length <= max', () => {
    const msgs = make(5)
    const out = boundHistory(msgs, 20)
    expect(out).toBe(msgs)
    expect(out).toEqual(msgs)
  })

  it('returns as-is when length exactly equals max', () => {
    const msgs = make(MAX_HISTORY_MESSAGES)
    expect(boundHistory(msgs)).toBe(msgs)
  })

  it('keeps exactly the last `max` messages, in order, ending with the last message', () => {
    const msgs = make(50)
    const out = boundHistory(msgs, MAX_HISTORY_MESSAGES)
    expect(out).toHaveLength(MAX_HISTORY_MESSAGES)
    expect(out[0].content).toBe(`m${50 - MAX_HISTORY_MESSAGES}`)
    expect(out[out.length - 1]).toBe(msgs[msgs.length - 1])
    expect(out).toEqual(msgs.slice(-MAX_HISTORY_MESSAGES))
  })

  it('always ends with the latest user message', () => {
    const msgs = make(50) // index 48 is the last user message (even index)
    const out = boundHistory(msgs, MAX_HISTORY_MESSAGES)
    const lastUser = [...out].reverse().find(m => m.role === 'user')
    expect(lastUser).toBe(msgs[msgs.length - 2])
    // and the true last user message of the full array is still present
    expect(out).toContain(msgs[msgs.length - 2])
  })

  it('returns empty for empty input', () => {
    expect(boundHistory([])).toEqual([])
  })

  it('returns only the last message when max <= 0 (never zero) for non-empty input', () => {
    const msgs = make(5)
    expect(boundHistory(msgs, 0)).toEqual([msgs[4]])
    expect(boundHistory(msgs, -3)).toEqual([msgs[4]])
    expect(boundHistory(msgs, 0)).toHaveLength(1)
  })

  it('returns empty when max <= 0 and input is empty', () => {
    expect(boundHistory([], 0)).toEqual([])
  })

  it('is generic over message shape (works on {role, content})', () => {
    const shaped = [
      { role: 'user', content: 'a', extra: 1 },
      { role: 'assistant', content: 'b', extra: 2 },
      { role: 'user', content: 'c', extra: 3 },
    ]
    const out = boundHistory(shaped, 2)
    expect(out).toEqual([shaped[1], shaped[2]])
    // preserved shape, including non-role fields
    expect(out[0].extra).toBe(2)
  })
})
