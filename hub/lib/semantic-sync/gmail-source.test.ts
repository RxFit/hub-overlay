import { describe, it, expect, vi } from 'vitest'
import {
  buildGmailQuery,
  createGmailSource,
  extractMessageText,
  gmailMessageToDoc,
  htmlToText,
  stripQuotedReply,
  type GmailMessage,
} from './gmail-source'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

function message(id: string, internalDate: number, overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ['INBOX'],
    internalDate: String(internalDate),
    snippet: 'snippet',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: `Subject ${id}` },
        { name: 'From', value: 'Jane <jane@example.com>' },
        { name: 'To', value: 'danny@rxfitatx.com, ops@rxfitatx.com' },
      ],
      body: { data: b64(`Body of ${id}`) },
    },
    ...overrides,
  }
}

describe('buildGmailQuery', () => {
  it('bounds the window in epoch seconds, excludes drafts, and ANDs the filter', () => {
    const q = buildGmailQuery(new Date(1_700_000_000_500), new Date(1_700_086_400_000), '-category:promotions')
    expect(q).toBe('after:1700000000 before:1700086400 -in:drafts -category:promotions')
    expect(buildGmailQuery(new Date(0), new Date(1000), '  ')).toBe('after:0 before:1 -in:drafts')
  })
})

describe('body extraction', () => {
  it('prefers text/plain and lists attachments by name without their bytes', () => {
    const { body, attachments } = extractMessageText({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('plain wins') } },
            { mimeType: 'text/html', body: { data: b64('<p>html loses</p>') } },
          ],
        },
        { mimeType: 'application/pdf', filename: 'waiver.pdf', body: { attachmentId: 'att1', size: 1234 } },
      ],
    })
    expect(body).toBe('plain wins')
    expect(attachments).toEqual(['waiver.pdf'])
  })

  it('falls back to de-tagged HTML', () => {
    const { body } = extractMessageText({
      mimeType: 'text/html',
      body: { data: b64('<html><head><style>p{}</style></head><body><p>Hello&nbsp;there</p><p>A &amp;lt; B</p></body></html>') },
    })
    expect(body).toBe('Hello there\nA &lt; B')
  })

  it('htmlToText drops scripts and decodes numeric entities', () => {
    expect(htmlToText('<script>x()</script>caf&#233;<br>ok')).toBe('café\nok')
  })

  it('strips quoted reply history but keeps an all-quote message', () => {
    expect(stripQuotedReply('Sounds good.\n\nOn Mon, Sep 22, 2026 at 9:00 AM Jane <j@x.com> wrote:\n> earlier text')).toBe(
      'Sounds good.',
    )
    expect(stripQuotedReply('new line\n> quoted\nmore')).toBe('new line\nmore')
    expect(stripQuotedReply('On Mon, Jane wrote:\nstill here')).toBe('On Mon, Jane wrote:\nstill here')
  })
})

describe('gmailMessageToDoc', () => {
  it('maps a message to a stable, filterable document', () => {
    const doc = gmailMessageToDoc(message('18c5', Date.parse('2026-09-25T10:00:00Z'), { labelIds: ['SENT'] }), 'danny@rxfitatx.com')
    expect(doc.id).toBe('gmail-18c5')
    expect(doc.title).toBe('Email: Subject 18c5')
    expect(doc.body).toBe('Body of 18c5')
    expect(doc.structData).toMatchObject({
      source: 'gmail',
      mailbox: 'danny@rxfitatx.com',
      direction: 'sent',
      to: ['danny@rxfitatx.com', 'ops@rxfitatx.com'],
      date: '2026-09-25T10:00:00.000Z',
      thread_id: 't-18c5',
    })
  })
})

describe('createGmailSource.collect', () => {
  const since = new Date('2026-09-25T00:00:00Z')
  const until = new Date('2026-09-26T00:00:00Z')

  /** Gmail lists newest first; ids here are named by age (m1 oldest). */
  function fakeGmail(ids: string[], opts: { missing?: string[] } = {}) {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.includes('/messages?')) {
        return Response.json({ messages: [...ids].reverse().map((id) => ({ id })) })
      }
      const id = decodeURIComponent(url.split('/messages/')[1].split('?')[0])
      if (opts.missing?.includes(id)) return new Response('', { status: 404 })
      const n = Number(id.slice(1))
      return Response.json(message(id, since.getTime() + n * 60_000))
    })
    return { fetchImpl, calls }
  }

  it('processes the whole window oldest first and resumes at `until`', async () => {
    const { fetchImpl, calls } = fakeGmail(['m1', 'm2', 'm3'])
    const source = createGmailSource({ subject: 'd@x.co', query: '-category:social', fetchImpl, token: async () => 'tok' })
    const out = await source.collect({ since, until }, { maxItems: 10 })
    expect(out.docs.map((d) => d.id)).toEqual(['gmail-m1', 'gmail-m2', 'gmail-m3'])
    expect(out).toMatchObject({ scanned: 3, truncated: false, cursor: until })
    expect(decodeURIComponent(calls[0])).toContain('-category:social')
  })

  it('truncates at maxItems from the OLD end, so the cursor never skips a message', async () => {
    const { fetchImpl } = fakeGmail(['m1', 'm2', 'm3', 'm4'])
    const source = createGmailSource({ subject: 'd@x.co', query: '', fetchImpl, token: async () => 'tok' })
    const out = await source.collect({ since, until }, { maxItems: 2 })
    expect(out.docs.map((d) => d.id)).toEqual(['gmail-m1', 'gmail-m2'])
    expect(out.truncated).toBe(true)
    expect(out.cursor).toEqual(new Date(since.getTime() + 2 * 60_000))
  })

  it('skips a message deleted between list and get', async () => {
    const { fetchImpl } = fakeGmail(['m1', 'm2'], { missing: ['m2'] })
    const source = createGmailSource({ subject: 'd@x.co', query: '', fetchImpl, token: async () => 'tok' })
    const out = await source.collect({ since, until }, { maxItems: 10 })
    expect(out.docs.map((d) => d.id)).toEqual(['gmail-m1'])
  })

  it('surfaces a list failure with the collect stage and Google\'s message', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: { status: 'PERMISSION_DENIED', message: 'Delegation denied' } }, { status: 403 }),
    )
    const source = createGmailSource({ subject: 'd@x.co', query: '', fetchImpl, token: async () => 'tok' })
    await expect(source.collect({ since, until }, { maxItems: 10 })).rejects.toMatchObject({
      name: 'SemanticSyncError',
      stage: 'collect',
      httpStatus: 403,
      message: expect.stringContaining('Delegation denied'),
    })
  })
})
