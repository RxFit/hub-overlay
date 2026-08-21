import { describe, it, expect, vi, afterEach } from 'vitest'
import { searchGmailThreads } from './google'

/* ════════════════════════════════════════════════════════════════════════════
   searchGmailThreads — the wire contract under the assistant's search_gmail
   tool. Query grammar forwarded verbatim (encoded), NOT restricted to INBOX
   (search exists to reach archived mail), metadata-only thread fan-out, and a
   single bad thread drops instead of failing the search.
   ════════════════════════════════════════════════════════════════════════════ */

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const thread = (id: string) => ({
  id,
  messages: [{
    id: `${id}-m1`,
    threadId: id,
    labelIds: ['INBOX'],
    snippet: `snippet of ${id}`,
    internalDate: '1755000000000',
    payload: {
      headers: [
        { name: 'From', value: `sender-${id}@x.com` },
        { name: 'Subject', value: `subject ${id}` },
        { name: 'Date', value: 'Mon, 11 Aug 2026 09:00:00 -0500' },
      ],
    },
  }],
})

it('forwards the query, caps results, and fans out metadata-only thread reads', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    if (/\/threads\?/.test(url)) {
      return new Response(JSON.stringify({ threads: [{ id: 't1' }, { id: 't2' }] }), { status: 200 })
    }
    const id = url.match(/threads\/(t\d)/)?.[1] ?? 't?'
    return new Response(JSON.stringify(thread(id)), { status: 200 })
  }))

  const out = await searchGmailThreads('tok', 'from:vendor invoice', { maxResults: 5 })

  const listUrl = decodeURIComponent(calls[0].replace(/\+/g, ' '))
  expect(listUrl).toContain('q=from:vendor invoice')
  expect(listUrl).toContain('maxResults=5')
  expect(listUrl).not.toContain('labelIds')
  expect(calls.filter(u => u.includes('format=metadata'))).toHaveLength(2)
  expect(out.map(t => t.subject)).toEqual(['subject t1', 'subject t2'])
})

it('drops a single failing thread instead of failing the whole search', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (/\/threads\?/.test(url)) {
      return new Response(JSON.stringify({ threads: [{ id: 't1' }, { id: 't2' }] }), { status: 200 })
    }
    if (url.includes('threads/t2')) return new Response('boom', { status: 500 })
    return new Response(JSON.stringify(thread('t1')), { status: 200 })
  }))

  const out = await searchGmailThreads('tok', 'anything')
  expect(out.map(t => t.id)).toEqual(['t1'])
})

it('returns [] on an empty result set without any fan-out', async () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  expect(await searchGmailThreads('tok', 'zzz')).toEqual([])
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
