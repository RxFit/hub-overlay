import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isPrivateAddress, fetchDriveDocContent, fetchUrlContent, createPinnedLookup } from '@/lib/content-fetch'

// Mutable DNS result so each test can steer hostname resolution (drives the
// SSRF assessment + IP-pinning path in fetchUrlContent).
const { dns } = vi.hoisted(() => ({ dns: { records: [] as { address: string; family: number }[] } }))
vi.mock('dns/promises', () => ({
  lookup: vi.fn(async () => dns.records),
}))

describe('isPrivateAddress (SSRF guard)', () => {
  it('blocks IPv4 loopback and private ranges', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('10.1.2.3')).toBe(true)
    expect(isPrivateAddress('192.168.0.1')).toBe(true)
    expect(isPrivateAddress('172.16.0.1')).toBe(true)
    expect(isPrivateAddress('172.31.255.255')).toBe(true)
    expect(isPrivateAddress('0.0.0.0')).toBe(true)
  })

  it('blocks the cloud metadata / link-local range', () => {
    expect(isPrivateAddress('169.254.169.254')).toBe(true)
  })

  it('blocks CGNAT 100.64.0.0/10', () => {
    expect(isPrivateAddress('100.64.0.1')).toBe(true)
    expect(isPrivateAddress('100.127.255.255')).toBe(true)
    // outside the /10 is public
    expect(isPrivateAddress('100.128.0.1')).toBe(false)
  })

  it('allows ordinary public IPv4', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('1.1.1.1')).toBe(false)
    expect(isPrivateAddress('172.32.0.1')).toBe(false) // just outside 172.16/12
  })

  it('blocks IPv6 loopback, unique-local, link-local', () => {
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('fd00::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
  })

  it('blocks IPv4-mapped IPv6 that wraps a private IP (bypass attempt)', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateAddress('[::ffff:169.254.169.254]')).toBe(true)
  })

  it('allows a public IPv6 address', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
  })
})

describe('createPinnedLookup (SSRF IP-pin / rebind guard)', () => {
  it('returns the single pre-vetted address when options.all is falsy', () => {
    const lookup = createPinnedLookup([{ address: '93.184.216.34', family: 4 }])
    const cb = vi.fn()
    lookup('example.com', { all: false }, cb)
    expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4)
  })

  it('returns the full vetted array when options.all is true', () => {
    const addrs = [{ address: '93.184.216.34', family: 4 }, { address: '1.1.1.1', family: 4 }]
    const lookup = createPinnedLookup(addrs)
    const cb = vi.fn()
    lookup('example.com', { all: true }, cb)
    expect(cb).toHaveBeenCalledWith(null, addrs)
  })

  it('errors (blocks connect) if a pinned address is private — post-validation rebind defense', () => {
    const lookup = createPinnedLookup([{ address: '169.254.169.254', family: 4 }])
    const cb = vi.fn()
    lookup('rebind.example.com', { all: false }, cb)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(cb.mock.calls[0][1]).toBe('')
  })
})

describe('fetchUrlContent (SSRF)', () => {
  beforeEach(() => {
    dns.records = []
    vi.unstubAllGlobals()
  })

  it('blocks a literal private IP without fetching', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const out = await fetchUrlContent('http://169.254.169.254/latest/meta-data/')
    expect(out).toContain('[Blocked')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('blocks a non-http(s) protocol', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const out = await fetchUrlContent('file:///etc/passwd')
    expect(out).toContain('[Blocked')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('blocks a hostname that resolves to a private IP (DNS-based SSRF)', async () => {
    dns.records = [{ address: '10.0.0.5', family: 4 }]
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const out = await fetchUrlContent('http://internal.example.com/')
    expect(out).toContain('[Blocked')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches a public hostname pinned to the vetted IP (dispatcher passed to fetch)', async () => {
    dns.records = [{ address: '93.184.216.34', family: 4 }]
    const fetchSpy = vi.fn(async (_url: unknown, init: RequestInit & { dispatcher?: unknown }) => {
      // The connection must be pinned via an undici dispatcher, and redirects
      // must not auto-follow.
      expect(init.dispatcher).toBeDefined()
      expect(init.redirect).toBe('error')
      return new Response('hello world', { status: 200, headers: { 'content-type': 'text/plain' } })
    })
    vi.stubGlobal('fetch', fetchSpy)
    const out = await fetchUrlContent('http://example.com/')
    expect(out).toBe('hello world')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('fetchDriveDocContent (F4 — abort timeout)', () => {
  it('passes an AbortSignal to the Drive export fetch (F4)', async () => {
    const fetchSpy = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response('doc text', {
        status: 200, headers: { 'content-type': 'text/plain' },
      }))
    )
    vi.stubGlobal('fetch', fetchSpy)

    await fetchDriveDocContent('tok', 'fileId', 'application/vnd.google-apps.document')

    const init = fetchSpy.mock.calls[0][1]
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    vi.unstubAllGlobals()
  })
})

describe('fetchDriveDocContent (export mime by Google file type)', () => {
  const stubExport = () => {
    const fetchSpy = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response('exported', {
        status: 200, headers: { 'content-type': 'text/plain' },
      }))
    )
    vi.stubGlobal('fetch', fetchSpy)
    return fetchSpy
  }

  it('exports Google Sheets as text/csv (text/plain is an unsupported conversion → 400)', async () => {
    const fetchSpy = stubExport()
    await fetchDriveDocContent('tok', 'sheetId', 'application/vnd.google-apps.spreadsheet')
    expect(String(fetchSpy.mock.calls[0][0])).toContain(`mimeType=${encodeURIComponent('text/csv')}`)
    vi.unstubAllGlobals()
  })

  it('exports Google Docs as text/plain', async () => {
    const fetchSpy = stubExport()
    await fetchDriveDocContent('tok', 'docId', 'application/vnd.google-apps.document')
    expect(String(fetchSpy.mock.calls[0][0])).toContain(`mimeType=${encodeURIComponent('text/plain')}`)
    vi.unstubAllGlobals()
  })

  it('exports Google Slides as text/plain', async () => {
    const fetchSpy = stubExport()
    await fetchDriveDocContent('tok', 'slidesId', 'application/vnd.google-apps.presentation')
    expect(String(fetchSpy.mock.calls[0][0])).toContain(`mimeType=${encodeURIComponent('text/plain')}`)
    vi.unstubAllGlobals()
  })
})
