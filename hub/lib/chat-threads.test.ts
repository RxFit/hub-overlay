import { describe, it, expect } from 'vitest'
import {
  groupMessagesByThread,
  spaceSupportsThreadReplies,
  threadLastActivity,
  threadReplyCount,
} from './chat-threads'

/* ════════════════════════════════════════════════════════════════════════════
   lib/chat-threads — rebuilding Google Chat's collapsed-thread view from the
   FLAT page `spaces.messages.list` returns (replies interleaved with starters
   in createTime order, structure carried only by each message's thread.name).
   ════════════════════════════════════════════════════════════════════════════ */

const msg = (
  name: string,
  createTime: string,
  threadName?: string,
  threadReply?: boolean,
) => ({
  name: `spaces/S/messages/${name}`,
  createTime,
  ...(threadName ? { thread: { name: `spaces/S/threads/${threadName}` } } : {}),
  ...(threadReply !== undefined ? { threadReply } : {}),
})

describe('groupMessagesByThread', () => {
  it('collapses interleaved replies under their thread starter, preserving thread order', () => {
    // The exact shape the API returns: B's reply lands BETWEEN two other
    // top-level messages; the grouped view must fold it back under B.
    const groups = groupMessagesByThread([
      msg('a1', '2026-08-01T10:00:00Z', 'A'),
      msg('b1', '2026-08-01T10:01:00Z', 'B'),
      msg('a2', '2026-08-01T10:02:00Z', 'A', true),
      msg('c1', '2026-08-01T10:03:00Z', 'C'),
      msg('a3', '2026-08-01T10:04:00Z', 'A', true),
    ])

    expect(groups.map(g => g.root.name)).toEqual([
      'spaces/S/messages/a1',
      'spaces/S/messages/b1',
      'spaces/S/messages/c1',
    ])
    expect(groups[0].replies.map(r => r.name)).toEqual([
      'spaces/S/messages/a2',
      'spaces/S/messages/a3',
    ])
    expect(groups[0].threadName).toBe('spaces/S/threads/A')
    expect(groups[0].rootMissing).toBe(false)
    expect(groups[1].replies).toEqual([])
  })

  it('flags a thread whose starter fell off the page window (oldest in-page message is a reply)', () => {
    const groups = groupMessagesByThread([
      msg('a7', '2026-08-01T10:00:00Z', 'A', true),
      msg('a8', '2026-08-01T10:01:00Z', 'A', true),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].rootMissing).toBe(true)
    expect(groups[0].replies.map(r => r.name)).toEqual(['spaces/S/messages/a8'])
  })

  it('gives a message with no thread name its own reply-less group instead of merging strangers', () => {
    const groups = groupMessagesByThread([
      msg('x', '2026-08-01T10:00:00Z'),
      msg('y', '2026-08-01T10:01:00Z'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups.every(g => g.threadName === null)).toBe(true)
    expect(groups.every(g => g.replies.length === 0)).toBe(true)
  })

  it('returns [] for an empty page', () => {
    expect(groupMessagesByThread([])).toEqual([])
  })
})

describe('threadReplyCount / threadLastActivity', () => {
  it('counts in-page replies, adding one for a stand-in root (itself a reply)', () => {
    const [complete] = groupMessagesByThread([
      msg('a1', '2026-08-01T10:00:00Z', 'A'),
      msg('a2', '2026-08-01T10:01:00Z', 'A', true),
    ])
    expect(threadReplyCount(complete)).toBe(1)

    const [truncated] = groupMessagesByThread([
      msg('a7', '2026-08-01T10:00:00Z', 'A', true),
      msg('a8', '2026-08-01T10:01:00Z', 'A', true),
    ])
    expect(threadReplyCount(truncated)).toBe(2)
  })

  it('reports the latest reply time, or the root time for reply-less groups', () => {
    const [withReplies] = groupMessagesByThread([
      msg('a1', '2026-08-01T10:00:00Z', 'A'),
      msg('a2', '2026-08-01T11:30:00Z', 'A', true),
    ])
    expect(threadLastActivity(withReplies)).toBe('2026-08-01T11:30:00Z')

    const [bare] = groupMessagesByThread([msg('b1', '2026-08-01T09:00:00Z', 'B')])
    expect(threadLastActivity(bare)).toBe('2026-08-01T09:00:00Z')
  })
})

describe('spaceSupportsThreadReplies', () => {
  it('trusts spaceThreadingState when present', () => {
    expect(spaceSupportsThreadReplies({ spaceThreadingState: 'THREADED_MESSAGES' })).toBe(true)
    expect(spaceSupportsThreadReplies({ spaceThreadingState: 'GROUPED_MESSAGES' })).toBe(true)
    // A DM reports UNTHREADED even though its spaceType would never say SPACE;
    // the explicit state must also beat a stale/odd spaceType.
    expect(
      spaceSupportsThreadReplies({ spaceType: 'SPACE', spaceThreadingState: 'UNTHREADED_MESSAGES' }),
    ).toBe(false)
  })

  it('falls back to the spaceType discriminator when threading state is absent', () => {
    expect(spaceSupportsThreadReplies({ spaceType: 'SPACE' })).toBe(true)
    expect(spaceSupportsThreadReplies({ spaceType: 'DIRECT_MESSAGE' })).toBe(false)
    expect(spaceSupportsThreadReplies({ spaceType: 'GROUP_CHAT' })).toBe(false)
    expect(spaceSupportsThreadReplies({})).toBe(false)
  })
})
