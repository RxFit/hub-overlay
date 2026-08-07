import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  planChannelAction,
  fetchStartPageToken,
  watchChanges,
  stopChannel,
  listChanges,
  shouldIngestChange,
  InvalidPageTokenError,
  RENEWAL_WINDOW_MS,
} from './watch-channels'

/* Drive push channels expire on Google's schedule; before the renewal cron
   existed the lapse was SILENT — the semantic index just stopped updating.
   These pin the renewal policy and the API wrappers it depends on. */

const realFetch = global.fetch
let calls: { url: string; init?: RequestInit }[] = []

function stub(handler: (url: string) => unknown) {
  calls = []
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const body = handler(url)
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
}

beforeEach(() => { calls = [] })
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks() })

describe('planChannelAction', () => {
  const now = new Date('2026-08-07T12:00:00Z')

  it('bootstraps when no channel is stored', () => {
    expect(planChannelAction(null, now)).toBe('bootstrap')
    expect(planChannelAction(undefined, now)).toBe('bootstrap')
  })

  it('renews inside the window, and for already-expired channels', () => {
    const soon = new Date(now.getTime() + RENEWAL_WINDOW_MS - 60_000)
    expect(planChannelAction({ expiration: soon }, now)).toBe('renew')
    const past = new Date(now.getTime() - 60_000)
    expect(planChannelAction({ expiration: past }, now)).toBe('renew')
  })

  it('reports healthy outside the window', () => {
    const later = new Date(now.getTime() + RENEWAL_WINDOW_MS + 60_000)
    expect(planChannelAction({ expiration: later }, now)).toBe('healthy')
  })
})

describe('watchChanges', () => {
  it('registers a web_hook channel spanning all drives and returns the GRANTED expiration', async () => {
    stub(() => ({ resourceId: 'res-1', expiration: '1790000000000' }))
    const ch = await watchChanges('tok', {
      channelId: 'chan-1',
      pageToken: 'pt-5',
      address: 'https://hub.example.com/api/webhooks/google',
      channelToken: 'secret-token',
    })
    const { url, init } = calls[0]
    expect(url).toContain('/changes/watch')
    expect(url).toContain('pageToken=pt-5')
    expect(url).toContain('supportsAllDrives=true')
    expect(url).toContain('includeItemsFromAllDrives=true')
    const body = JSON.parse(String(init?.body))
    expect(body.id).toBe('chan-1')
    expect(body.type).toBe('web_hook')
    expect(body.address).toBe('https://hub.example.com/api/webhooks/google')
    expect(body.token).toBe('secret-token')
    // Google's clamped grant wins over what we asked for.
    expect(ch).toEqual({ channelId: 'chan-1', resourceId: 'res-1', expiration: new Date(1790000000000) })
  })

  it('throws when Drive rejects the watch', async () => {
    stub(() => new Response('quota exceeded', { status: 403 }))
    await expect(
      watchChanges('tok', { channelId: 'c', pageToken: 'p', address: 'a', channelToken: 't' }),
    ).rejects.toThrow('Drive watch API 403')
  })
})

describe('stopChannel', () => {
  it('posts id + resourceId to channels/stop', async () => {
    stub(() => ({}))
    await stopChannel('tok', 'chan-old', 'res-old')
    expect(calls[0].url).toContain('/channels/stop')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ id: 'chan-old', resourceId: 'res-old' })
  })

  it('never throws — an already-dead channel is the desired state', async () => {
    stub(() => new Response('not found', { status: 404 }))
    await expect(stopChannel('tok', 'chan-old', 'res-old')).resolves.toBeUndefined()
  })
})

describe('fetchStartPageToken', () => {
  it('reads the cursor with shared-drive support', async () => {
    stub(() => ({ startPageToken: '4711' }))
    expect(await fetchStartPageToken('tok')).toBe('4711')
    expect(calls[0].url).toContain('supportsAllDrives=true')
  })
})

describe('listChanges', () => {
  it('follows pagination and maps removed/trashed/file fields', async () => {
    stub(url =>
      url.includes('pageToken=page-2')
        ? {
            changes: [{ fileId: 'f3', file: { name: 'Doc3', mimeType: 'application/vnd.google-apps.document' } }],
            newStartPageToken: 'next-cursor',
          }
        : {
            changes: [
              { fileId: 'f1', removed: true },
              { fileId: 'f2', file: { name: 'Doc2', mimeType: 'text/plain', trashed: true } },
            ],
            nextPageToken: 'page-2',
          },
    )
    const batch = await listChanges('tok', 'page-1')
    expect(batch.newStartPageToken).toBe('next-cursor')
    expect(batch.changes).toEqual([
      { fileId: 'f1', removed: true, trashed: false, mimeType: undefined, name: undefined },
      { fileId: 'f2', removed: false, trashed: true, mimeType: 'text/plain', name: 'Doc2' },
      { fileId: 'f3', removed: false, trashed: false, mimeType: 'application/vnd.google-apps.document', name: 'Doc3' },
    ])
    expect(calls[0].url).toContain('includeItemsFromAllDrives=true')
  })

  it('surfaces a rejected cursor as InvalidPageTokenError so the caller can reset it', async () => {
    stub(() => new Response('Invalid Value for pageToken', { status: 400 }))
    await expect(listChanges('tok', 'ancient')).rejects.toBeInstanceOf(InvalidPageTokenError)
  })
})

describe('shouldIngestChange', () => {
  const base = { fileId: 'f', removed: false, trashed: false }

  it('ingests documents, skips folders and removals', () => {
    expect(shouldIngestChange({ ...base, mimeType: 'application/vnd.google-apps.document' })).toBe(true)
    expect(shouldIngestChange({ ...base, mimeType: 'application/vnd.google-apps.folder' })).toBe(false)
    expect(shouldIngestChange({ ...base, removed: true, mimeType: 'text/plain' })).toBe(false)
    expect(shouldIngestChange({ ...base, trashed: true, mimeType: 'text/plain' })).toBe(false)
  })

  it('offers unknown mime types to the ingestor (its extractor skips binaries itself)', () => {
    expect(shouldIngestChange({ ...base, mimeType: undefined })).toBe(true)
  })
})
