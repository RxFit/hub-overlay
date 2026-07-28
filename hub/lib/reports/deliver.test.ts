import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveRecipients, buildDigestEmail, deliverDigest, ADMINS_TOKEN } from './deliver'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const decode = (raw: string) =>
  Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

const ADMINS = ['danny@rxfitatx.com', 'ops@rxfitatx.com']

describe('resolveRecipients', () => {
  it('expands the admins token', () => {
    expect(resolveRecipients({ email: [ADMINS_TOKEN] }, ADMINS)).toEqual(ADMINS)
  })

  it('keeps literal addresses alongside the token', () => {
    expect(resolveRecipients({ email: [ADMINS_TOKEN, 'client@acme.com'] }, ADMINS)).toEqual([
      ...ADMINS,
      'client@acme.com',
    ])
  })

  it('deduplicates case-insensitively so nobody gets two copies', () => {
    expect(
      resolveRecipients({ email: [ADMINS_TOKEN, 'DANNY@rxfitatx.com'] }, ADMINS),
    ).toEqual(ADMINS)
  })

  it('drops malformed addresses rather than bouncing the send', () => {
    expect(resolveRecipients({ email: ['not-an-email', 'ok@x.com'] }, [])).toEqual(['ok@x.com'])
  })

  it('returns nothing for a Drive-only report', () => {
    expect(resolveRecipients({ email: [] }, ADMINS)).toEqual([])
  })
})

describe('buildDigestEmail', () => {
  const base = {
    from: 'danny@rxfitatx.com',
    to: ['ops@rxfitatx.com'],
    title: 'Weekly performance digest',
    startDate: '2026-07-21',
    endDate: '2026-07-27',
    documentUrl: 'https://docs.google.com/document/d/abc/edit',
  }

  it('links the Doc rather than inlining the report', () => {
    // The Doc is the canonical artifact; a second renderer would drift from it.
    const raw = decode(buildDigestEmail(base))
    expect(raw).toContain('https://docs.google.com/document/d/abc/edit')
    expect(raw).toContain('Subject: Weekly performance digest — 2026-07-21 to 2026-07-27')
  })

  it('addresses every recipient on one To header', () => {
    const raw = decode(buildDigestEmail({ ...base, to: ['a@x.com', 'b@x.com'] }))
    expect(raw).toContain('To: a@x.com, b@x.com')
  })

  it('includes notes when the digest had gaps', () => {
    const raw = decode(buildDigestEmail({ ...base, notes: ['Search Console unavailable'] }))
    expect(raw).toContain('Search Console unavailable')
  })

  it('strips CR/LF so a title cannot inject headers', () => {
    const raw = decode(buildDigestEmail({ ...base, title: 'Digest\r\nBcc: evil@x.com' }))
    expect(raw).not.toMatch(/^Bcc:/m)
  })
})

describe('deliverDigest', () => {
  const message = {
    from: 'danny@rxfitatx.com',
    title: 'Weekly digest',
    startDate: '2026-07-21',
    endDate: '2026-07-27',
    documentUrl: 'https://docs.google.com/document/d/abc/edit',
  }

  function stub(handler: (url: string) => Response) {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return handler(url)
      }),
    )
    return calls
  }

  it('emails the resolved recipients', async () => {
    const calls = stub(() => new Response('{}', { status: 200 }))
    const out = await deliverDigest('tok', { email: [ADMINS_TOKEN] }, ADMINS, message)

    expect(out.emailed).toBe(2)
    expect(calls[0]).toContain('/messages/send')
  })

  it('posts to Chat when a space is configured', async () => {
    const calls = stub(() => new Response('{}', { status: 200 }))
    const out = await deliverDigest(
      'tok',
      { email: [], chatSpaceId: 'spaces/abc' },
      ADMINS,
      message,
    )

    expect(out.chatPosted).toBe(true)
    expect(calls[0]).toContain('spaces/abc/messages')
  })

  it('skips both channels for a Drive-only report', async () => {
    const calls = stub(() => new Response('{}', { status: 200 }))
    const out = await deliverDigest('tok', { email: [] }, ADMINS, message)

    expect(calls).toHaveLength(0)
    expect(out).toMatchObject({ emailed: 0, chatPosted: false, problems: [] })
  })

  it('reports a failure instead of throwing — the report still exists', async () => {
    stub(() => new Response('nope', { status: 500 }))
    const out = await deliverDigest('tok', { email: ['a@x.com'] }, ADMINS, message)

    expect(out.emailed).toBe(0)
    expect(out.problems[0]).toMatch(/email delivery failed/)
  })

  it('still posts to Chat when email fails', async () => {
    // Independent channels — one being down should not suppress the other.
    stub(url => (url.includes('/messages/send') ? new Response('x', { status: 500 }) : new Response('{}', { status: 200 })))
    const out = await deliverDigest(
      'tok',
      { email: ['a@x.com'], chatSpaceId: 'spaces/abc' },
      ADMINS,
      message,
    )

    expect(out.problems).toHaveLength(1)
    expect(out.chatPosted).toBe(true)
  })
})
