import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchDriveFiles, readDriveFileText } from '@/lib/google'

/**
 * The Drive API draws a hard line between native Workspace files (which must be
 * EXPORTED — `alt=media` 403s on them) and everything else (downloaded). Getting
 * that branch wrong is the difference between reading a Google Doc and handing
 * the model an error page, so it is pinned here.
 */

const realFetch = global.fetch
let calls: string[] = []

function stub(handler: (url: string) => Response) {
  calls = []
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    return handler(url)
  }) as typeof fetch
}

beforeEach(() => { calls = [] })
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks() })

/**
 * Decode a request URL for assertion.
 *
 * URLSearchParams encodes spaces as `+`, and decodeURIComponent does NOT turn
 * those back into spaces — so a naive decode makes a perfectly correct Drive
 * query look wrong.
 */
const readableUrl = (url: string) => decodeURIComponent(url).replace(/\+/g, ' ')

describe('searchDriveFiles', () => {
  it('searches file CONTENTS as well as names', async () => {
    stub(() => new Response(JSON.stringify({ files: [] }), { status: 200 }))
    await searchDriveFiles('tok', 'Nuvita')

    const url = readableUrl(calls[0])
    // fullText is what makes "find the partnership agreement" work when the
    // filename says nothing about partnerships.
    expect(url).toContain("fullText contains 'Nuvita'")
    expect(url).toContain("name contains 'Nuvita'")
  })

  it('always excludes trashed files', async () => {
    stub(() => new Response(JSON.stringify({ files: [] }), { status: 200 }))
    await searchDriveFiles('tok', 'x')
    expect(readableUrl(calls[0])).toContain('trashed = false')
  })

  it("escapes an apostrophe so the query literal isn't terminated early", async () => {
    stub(() => new Response(JSON.stringify({ files: [] }), { status: 200 }))
    await searchDriveFiles('tok', "Danny's plan")
    expect(readableUrl(calls[0])).toContain("fullText contains 'Danny\\'s plan'")
  })

  it('returns [] for a blank term without calling Drive', async () => {
    stub(() => new Response(JSON.stringify({ files: [] }), { status: 200 }))
    expect(await searchDriveFiles('tok', '   ')).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('returns [] when Drive responds with no files key', async () => {
    stub(() => new Response(JSON.stringify({}), { status: 200 }))
    expect(await searchDriveFiles('tok', 'x')).toEqual([])
  })
})

describe('readDriveFileText', () => {
  const meta = (mimeType: string, name = 'Doc') =>
    JSON.stringify({ id: 'f1', name, mimeType, webViewLink: 'https://drive/f1' })

  it('EXPORTS a native Google Doc to text/plain', async () => {
    stub(url => {
      if (url.includes('/export')) return new Response('the doc body', { status: 200 })
      return new Response(meta('application/vnd.google-apps.document'), { status: 200 })
    })

    const out = await readDriveFileText('tok', 'f1')

    expect(out.text).toBe('the doc body')
    const exportCall = readableUrl(calls.find(c => c.includes('/export'))!)
    expect(exportCall).toContain('mimeType=text/plain')
    // A native Doc has no bytes — alt=media would 403.
    expect(calls.some(c => c.includes('alt=media'))).toBe(false)
  })

  it('exports a Google Sheet as CSV', async () => {
    stub(url => {
      if (url.includes('/export')) return new Response('a,b\n1,2', { status: 200 })
      return new Response(meta('application/vnd.google-apps.spreadsheet'), { status: 200 })
    })

    const out = await readDriveFileText('tok', 'f1')
    expect(out.text).toBe('a,b\n1,2')
    expect(readableUrl(calls.find(c => c.includes('/export'))!)).toContain('mimeType=text/csv')
  })

  it('DOWNLOADS a plain-text file with alt=media', async () => {
    stub(url => {
      if (url.includes('alt=media')) return new Response('# notes', { status: 200 })
      return new Response(meta('text/markdown'), { status: 200 })
    })

    const out = await readDriveFileText('tok', 'f1')
    expect(out.text).toBe('# notes')
    expect(calls.some(c => c.includes('/export'))).toBe(false)
  })

  it('refuses a binary file with an explanation instead of returning mojibake', async () => {
    // A model handed garbled bytes will confidently invent content from them.
    stub(() => new Response(meta('application/pdf', 'Scan.pdf'), { status: 200 }))

    const out = await readDriveFileText('tok', 'f1')

    expect(out.text).toContain('application/pdf')
    expect(out.text).toContain('https://drive/f1')
    expect(out.truncated).toBe(false)
    // Only the metadata call — no attempt to download the bytes.
    expect(calls).toHaveLength(1)
  })

  it('truncates at maxChars and flags it', async () => {
    stub(url => {
      if (url.includes('/export')) return new Response('x'.repeat(500), { status: 200 })
      return new Response(meta('application/vnd.google-apps.document'), { status: 200 })
    })

    const out = await readDriveFileText('tok', 'f1', { maxChars: 100 })
    expect(out.text).toHaveLength(100)
    expect(out.truncated).toBe(true)
  })

  it('does not flag truncation when the file fits', async () => {
    stub(url => {
      if (url.includes('/export')) return new Response('short', { status: 200 })
      return new Response(meta('application/vnd.google-apps.document'), { status: 200 })
    })

    const out = await readDriveFileText('tok', 'f1', { maxChars: 100 })
    expect(out.truncated).toBe(false)
  })

  it('throws a status-tagged error when the content fetch fails', async () => {
    // The retrieval layer catches this and reports the lookup as failed rather
    // than letting the model answer as though nothing was searched.
    stub(url => {
      if (url.includes('/export')) return new Response('nope', { status: 403 })
      return new Response(meta('application/vnd.google-apps.document'), { status: 200 })
    })

    await expect(readDriveFileText('tok', 'f1')).rejects.toThrow(/403/)
  })
})
