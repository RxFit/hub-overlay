import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildGoogleWorkspaceContext } from './google-context'
import {
  listTaskLists,
  listTasks,
  listUpcomingEvents,
  listRecentFiles,
  listRecentGmailThreads,
  listChatSpaces,
  listChatMessages,
  type GmailThreadSummary,
  type ChatSpace,
  type ChatMessage,
} from './google'

/* ════════════════════════════════════════════════════════════════════════════
   buildGoogleWorkspaceContext (Plan 8 / F2)
   All Google fetchers are mocked. The snapshot must:
   - render a Gmail section with unread markers and set counts.unreadEmails,
   - render recent Chat messages under the first spaces,
   - degrade a failed service to its "[Could not load …]" line WITHOUT
     blanking the other sections,
   - enforce the Gmail (~1,800 char) and Chat-message (~1,500 char) caps.
   ════════════════════════════════════════════════════════════════════════════ */

vi.mock('./google', () => ({
  listTaskLists: vi.fn(),
  listTasks: vi.fn(),
  listUpcomingEvents: vi.fn(),
  listRecentFiles: vi.fn(),
  listRecentGmailThreads: vi.fn(),
  listChatSpaces: vi.fn(),
  listChatMessages: vi.fn(),
}))

const mocks = {
  listTaskLists: vi.mocked(listTaskLists),
  listTasks: vi.mocked(listTasks),
  listUpcomingEvents: vi.mocked(listUpcomingEvents),
  listRecentFiles: vi.mocked(listRecentFiles),
  listRecentGmailThreads: vi.mocked(listRecentGmailThreads),
  listChatSpaces: vi.mocked(listChatSpaces),
  listChatMessages: vi.mocked(listChatMessages),
}

function thread(id: string, over: Partial<GmailThreadSummary> = {}): GmailThreadSummary {
  return {
    id,
    subject: `Subject ${id}`,
    from: `sender-${id}@rxfitatx.com`,
    date: 'Fri, 03 Jul 2026 10:00:00 -0500',
    snippet: `snippet for ${id}`,
    isUnread: false,
    messageCount: 1,
    ...over,
  }
}

function space(name: string, displayName: string): ChatSpace {
  return { name, displayName, type: 'ROOM', spaceType: 'SPACE' }
}

function chatMsg(sender: string, text: string): ChatMessage {
  return {
    name: 'spaces/x/messages/y',
    sender: { name: 'users/1', displayName: sender },
    createTime: '2026-07-03T10:00:00Z',
    text,
  }
}

/** Pull one "### …" section out of the joined detail string. */
function section(detail: string, header: string): string {
  return detail.split('\n\n').find(s => s.startsWith(header)) ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listTaskLists.mockResolvedValue([])
  mocks.listTasks.mockResolvedValue([])
  mocks.listUpcomingEvents.mockResolvedValue([])
  mocks.listRecentFiles.mockResolvedValue([])
  mocks.listRecentGmailThreads.mockResolvedValue([
    thread('t1', { isUnread: true, subject: 'Q3 invoice overdue' }),
    thread('t2'),
    thread('t3', { isUnread: true }),
  ])
  mocks.listChatSpaces.mockResolvedValue([
    space('spaces/A', 'Ops Team'),
    space('spaces/B', 'Partners'),
  ])
  mocks.listChatMessages.mockResolvedValue([
    chatMsg('Danny', 'Can someone cover the 6am session?'),
    chatMsg('Maria', 'I got it'),
  ])
})

describe('buildGoogleWorkspaceContext — Gmail section', () => {
  it('renders inbox threads with unread markers and sets counts.unreadEmails', async () => {
    const { detail, counts } = await buildGoogleWorkspaceContext('token')

    const gmail = section(detail, '### Gmail')
    expect(gmail).toContain('### Gmail (inbox, most recent 3 threads — 2 unread)')
    expect(gmail).toContain('[UNREAD] "Q3 invoice overdue" — sender-t1@rxfitatx.com')
    expect(gmail).toContain(':: snippet for t1')
    // Read thread rendered without the marker
    expect(gmail).toContain('- "Subject t2" — sender-t2@rxfitatx.com')
    expect(counts.unreadEmails).toBe(2)
  })

  it('degrades to the "[Could not load …]" line on failure WITHOUT blanking other sections', async () => {
    mocks.listRecentGmailThreads.mockRejectedValue(new Error('Google API error 403: denied'))

    const { detail, counts } = await buildGoogleWorkspaceContext('token')

    expect(detail).toContain('### Gmail\n[Could not load Gmail this turn')
    // The other sections survive intact.
    expect(detail).toContain('### Tasks')
    expect(detail).toContain('### Calendar')
    expect(detail).toContain('### Drive')
    expect(detail).toContain('### Chat (2 spaces)')
    expect(detail).toContain('· Danny: Can someone cover the 6am session?')
    expect(counts.unreadEmails).toBeUndefined()
  })

  it('hard-caps the section and appends an "…and N more" truncation line', async () => {
    mocks.listRecentGmailThreads.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) =>
        thread(`t${i}`, { subject: 'S'.repeat(500), snippet: 'x'.repeat(500) }),
      ),
    )

    const { detail } = await buildGoogleWorkspaceContext('token')
    const gmail = section(detail, '### Gmail')

    // Snippet is per-line capped at ~120 chars, whole section at ~1,800.
    expect(gmail.length).toBeLessThanOrEqual(1_900)
    expect(gmail).toMatch(/…and \d+ more/)
    expect(gmail).not.toContain('x'.repeat(121))
  })

  it('truncates a hostile oversized subject/sender instead of collapsing the section', async () => {
    // The NEWEST thread carries a 2,000-char subject and a 500-char From. If
    // those fields were unbounded, line 1 would blow the 1,800 budget and the
    // whole section would collapse to header + "…and N more" (denial of
    // visibility). Per-field slices must keep the line AND later threads.
    mocks.listRecentGmailThreads.mockResolvedValue([
      thread('t1', { subject: 'A'.repeat(2_000), from: 'F'.repeat(500), isUnread: true }),
      thread('t2'),
      thread('t3'),
    ])

    const { detail } = await buildGoogleWorkspaceContext('token')
    const gmail = section(detail, '### Gmail')

    // The hostile thread still renders, truncated to the per-field caps.
    expect(gmail).toContain(`[UNREAD] "${'A'.repeat(120)}"`)
    expect(gmail).not.toContain('A'.repeat(121))
    expect(gmail).toContain('F'.repeat(80))
    expect(gmail).not.toContain('F'.repeat(81))
    // …and it does NOT crowd out the rest of the inbox.
    expect(gmail).toContain('"Subject t2" — sender-t2@rxfitatx.com')
    expect(gmail).toContain('"Subject t3" — sender-t3@rxfitatx.com')
    expect(gmail).not.toMatch(/…and \d+ more/)
  })
})

describe('buildGoogleWorkspaceContext — Chat messages', () => {
  it('renders the last messages under each of the first spaces', async () => {
    const { detail } = await buildGoogleWorkspaceContext('token')

    const chat = section(detail, '### Chat')
    expect(chat).toContain('- Ops Team [SPACE]')
    expect(chat).toContain('· Danny: Can someone cover the 6am session?')
    expect(chat).toContain('· Maria: I got it')
    expect(mocks.listChatMessages).toHaveBeenCalledWith('token', 'spaces/A', 5)
    expect(mocks.listChatMessages).toHaveBeenCalledWith('token', 'spaces/B', 5)
  })

  it('only fetches messages for the first 3 spaces', async () => {
    mocks.listChatSpaces.mockResolvedValue(
      ['A', 'B', 'C', 'D', 'E'].map(n => space(`spaces/${n}`, `Space ${n}`)),
    )

    const { detail } = await buildGoogleWorkspaceContext('token')

    expect(mocks.listChatMessages).toHaveBeenCalledTimes(3)
    // Later spaces still render as names-only.
    expect(detail).toContain('- Space E [SPACE]')
  })

  it('keeps the space list when a message fetch fails', async () => {
    mocks.listChatMessages.mockRejectedValue(new Error('chat.messages denied'))

    const { detail } = await buildGoogleWorkspaceContext('token')

    expect(detail).toContain('### Chat (2 spaces)')
    expect(detail).toContain('- Ops Team [SPACE]')
    expect(detail).not.toContain('·')
  })

  it('caps the added message content at ~1,500 chars total', async () => {
    mocks.listChatSpaces.mockResolvedValue(
      ['A', 'B', 'C'].map(n => space(`spaces/${n}`, `Space ${n}`)),
    )
    mocks.listChatMessages.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => chatMsg(`Sender${i}`, 'm'.repeat(400))),
    )

    const { detail } = await buildGoogleWorkspaceContext('token')

    const chat = section(detail, '### Chat')
    const msgLines = chat.match(/\n {4}· [^\n]*/g) ?? []
    expect(msgLines.length).toBeGreaterThan(0)
    expect(msgLines.length).toBeLessThan(15) // budget ran out before all 15
    const total = msgLines.reduce((n, l) => n + l.length, 0)
    expect(total).toBeLessThanOrEqual(1_500)
    // Per-message slice: no line carries more than ~100 chars of body.
    expect(chat).not.toContain('m'.repeat(101))
  })

  it('slices an oversized sender display name to ~80 chars', async () => {
    mocks.listChatMessages.mockResolvedValue([chatMsg('N'.repeat(300), 'hello')])

    const { detail } = await buildGoogleWorkspaceContext('token')

    expect(detail).toContain(`· ${'N'.repeat(80)}: hello`)
    expect(detail).not.toContain('N'.repeat(81))
  })
})
