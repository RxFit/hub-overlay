import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  countChatMessagesSince,
  hydrateBotDmDisplayNames,
  listChatMessages,
  listChatSpaces,
  sendChatMessage,
  type ChatSpace,
} from './google'

/* ════════════════════════════════════════════════════════════════════════════
   Google Chat adapter — the wire-level contracts the thread + app-DM features
   stand on. Stub the fetch layer (same approach as the calendar tests) and
   assert what actually goes to chat.googleapis.com:

   - sendChatMessage MUST pair a thread target with messageReplyOption:
     without it Google IGNORES the thread field and silently starts a new
     thread, which is precisely why the old threadKey path never replied.
   - listChatMessages scoped to a thread must use the thread.name filter.
   - listChatSpaces must NOT drop bot DMs anymore (that made app
     conversations like the Hermes agent unreachable).
   ════════════════════════════════════════════════════════════════════════════ */

function stubFetch(payload: unknown = {}) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function calledUrl(fetchMock: ReturnType<typeof stubFetch>, i = 0): string {
  return String((fetchMock.mock.calls[i] as unknown[])[0])
}

function calledBody(fetchMock: ReturnType<typeof stubFetch>, i = 0) {
  const init = (fetchMock.mock.calls[i] as unknown[])[1] as RequestInit
  return JSON.parse(init.body as string)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('sendChatMessage — thread targeting', () => {
  it('replies into an existing thread: thread.name in the body + the REQUIRED messageReplyOption', async () => {
    const fetchMock = stubFetch({ name: 'spaces/S/messages/m1' })
    await sendChatMessage('tok', 'spaces/S', 'on it', { threadName: 'spaces/S/threads/T' })

    expect(calledUrl(fetchMock)).toContain('messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD')
    expect(calledBody(fetchMock)).toEqual({ text: 'on it', thread: { name: 'spaces/S/threads/T' } })
  })

  it('supports client-keyed threads via threadKey, still opting into the reply option', async () => {
    const fetchMock = stubFetch({ name: 'spaces/S/messages/m1' })
    await sendChatMessage('tok', 'spaces/S', 'hi', { threadKey: 'hub-key' })

    expect(calledUrl(fetchMock)).toContain('messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD')
    expect(calledBody(fetchMock)).toEqual({ text: 'hi', thread: { threadKey: 'hub-key' } })
  })

  it('prefers threadName when both targets are supplied', async () => {
    const fetchMock = stubFetch({})
    await sendChatMessage('tok', 'spaces/S', 'hi', {
      threadName: 'spaces/S/threads/T',
      threadKey: 'ignored',
    })
    expect(calledBody(fetchMock).thread).toEqual({ name: 'spaces/S/threads/T' })
  })

  it('sends a plain message with NO thread and NO reply option (starts a new thread, as before)', async () => {
    const fetchMock = stubFetch({})
    await sendChatMessage('tok', 'spaces/S', 'hello')

    expect(calledUrl(fetchMock)).not.toContain('messageReplyOption')
    expect(calledBody(fetchMock)).toEqual({ text: 'hello' })
  })
})

describe('listChatMessages — thread scoping', () => {
  it('filters by thread.name when a thread is requested', async () => {
    const fetchMock = stubFetch({ messages: [] })
    await listChatMessages('tok', 'spaces/S', 100, { threadName: 'spaces/S/threads/T' })

    const url = decodeURIComponent(calledUrl(fetchMock).replace(/\+/g, ' '))
    expect(url).toContain('filter=thread.name = spaces/S/threads/T')
  })

  it('lists the space plainly (no filter) when no thread is given', async () => {
    const fetchMock = stubFetch({ messages: [] })
    await listChatMessages('tok', 'spaces/S')
    expect(calledUrl(fetchMock)).not.toContain('filter=')
  })
})

describe('countChatMessagesSince — the lean unread read', () => {
  it('sends a quoted createTime filter plus a field mask, and returns the count', async () => {
    const fetchMock = stubFetch({
      messages: [
        { name: 'spaces/S/messages/m1', createTime: '2026-08-20T10:05:00Z' },
        { name: 'spaces/S/messages/m2', createTime: '2026-08-20T10:06:00Z' },
      ],
    })
    const count = await countChatMessagesSince('tok', 'spaces/S', '2026-08-20T10:00:00Z')
    expect(count).toBe(2)

    const url = decodeURIComponent(calledUrl(fetchMock).replace(/\+/g, ' '))
    expect(url).toContain('filter=createTime > "2026-08-20T10:00:00Z"')
    expect(url).toContain('fields=messages(name,createTime)')
  })

  it('returns 0 for an empty (fields-masked) response body', async () => {
    stubFetch({})
    expect(await countChatMessagesSince('tok', 'spaces/S', '2026-08-20T10:00:00Z')).toBe(0)
  })

  it('refuses a timestamp that could rewrite the filter grammar', async () => {
    stubFetch({})
    await expect(
      countChatMessagesSince('tok', 'spaces/S', '2026" OR createTime > "1970'),
    ).rejects.toThrow(/malformed timestamp/)
  })
})

describe('listChatSpaces — app DMs flow through', () => {
  it('keeps singleUserBotDm spaces so app conversations can be surfaced at all', async () => {
    stubFetch({
      spaces: [
        { name: 'spaces/OPS', displayName: 'Ops', spaceType: 'SPACE' },
        { name: 'spaces/HERMES', displayName: '', spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true },
      ],
    })
    const spaces = await listChatSpaces('tok')
    expect(spaces.map(s => s.name)).toEqual(['spaces/OPS', 'spaces/HERMES'])
  })
})

describe('hydrateBotDmDisplayNames', () => {
  const botDm = (name: string, displayName = ''): ChatSpace => ({
    name,
    displayName,
    type: 'DM',
    spaceType: 'DIRECT_MESSAGE',
    singleUserBotDm: true,
  })

  it('names an unnamed bot DM after its BOT member, leaving other spaces untouched', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/members')) {
        return new Response(JSON.stringify({
          memberships: [{
            name: 'spaces/HERMES/members/app',
            member: { name: 'users/app', displayName: 'Hermes', type: 'BOT' },
            role: 'ROLE_MEMBER',
            state: 'MEMBER_JOINED',
          }],
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const named: ChatSpace = { name: 'spaces/OPS', displayName: 'Ops', type: 'ROOM', spaceType: 'SPACE' }
    const out = await hydrateBotDmDisplayNames('tok', [named, botDm('spaces/HERMES')])

    expect(out[0]).toBe(named) // untouched, same reference
    expect(out[1].displayName).toBe('Hermes')
    // Only the bot DM triggered a members lookup.
    expect(fetchMock.mock.calls.filter(c => String(c[0]).includes('/members'))).toHaveLength(1)
  })

  it('skips bot DMs that already carry a name, and makes NO calls when nothing needs naming', async () => {
    const fetchMock = stubFetch({})
    const already = botDm('spaces/HERMES', 'Hermes')
    const out = await hydrateBotDmDisplayNames('tok', [already])
    expect(out).toEqual([already])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails soft when the membership lookup blows up — space stays listed, just unnamed', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await hydrateBotDmDisplayNames('tok', [botDm('spaces/HERMES')])
    expect(out[0].name).toBe('spaces/HERMES')
    expect(out[0].displayName).toBe('')
  })
})
