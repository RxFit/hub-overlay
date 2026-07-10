import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * P1-perf — attachment resolution is now CONCURRENT (Promise.all) instead of a
 * serial for-loop. These tests pin the behaviour that must survive the change:
 *  - the injected context is identical (same blocks, same input order),
 *  - one failing attachment degrades to a fallback block without sinking the batch
 *    (per-item error isolation),
 *  - the .slice(0,5) cap holds.
 *
 * withTimeout is stubbed to pass the promise through (no real timers), and every
 * upstream fetcher (Exa, raw fetch, Vertex, Drive) is mocked so the seam under
 * test is only the resolver's ordering/isolation logic.
 */

vi.mock('@/lib/timeout', () => ({
  withTimeout: (p: Promise<unknown>) => p,
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

const fetchUrlWithExa = vi.fn()
const fetchUrlContent = vi.fn()
const fetchDriveDocContent = vi.fn()
const searchSemanticBrain = vi.fn()

vi.mock('@/lib/exa', () => ({ fetchUrlWithExa: (...a: unknown[]) => fetchUrlWithExa(...a) }))
vi.mock('@/lib/content-fetch', () => ({
  fetchUrlContent: (...a: unknown[]) => fetchUrlContent(...a),
  fetchDriveDocContent: (...a: unknown[]) => fetchDriveDocContent(...a),
}))
vi.mock('@/lib/vertex', () => ({ searchSemanticBrain: (...a: unknown[]) => searchSemanticBrain(...a) }))

import { resolveAttachmentContext } from '@/lib/attachment-resolver'
import type { ChatAttachment, ChatMessage } from '@/types'

const lastUserMsg: ChatMessage = { id: 'm1', role: 'user', content: 'question', timestamp: '2026-01-01T00:00:00Z' }

beforeEach(() => {
  fetchUrlWithExa.mockReset()
  fetchUrlContent.mockReset()
  fetchDriveDocContent.mockReset()
  searchSemanticBrain.mockReset()
})

describe('resolveAttachmentContext', () => {
  it('returns empty string when there are no attachments', async () => {
    expect(await resolveAttachmentContext([], lastUserMsg, 'tok')).toBe('')
    expect(await resolveAttachmentContext(undefined, lastUserMsg, 'tok')).toBe('')
  })

  it('resolves mixed attachment types and PRESERVES input order of the blocks', async () => {
    fetchUrlWithExa.mockResolvedValue('exa-page-body')
    searchSemanticBrain.mockResolvedValue([{ title: 'DocT', snippet: 'DocS' }])

    const attachments: ChatAttachment[] = [
      { id: '1', type: 'text', label: 't1', content: 'hello world' },
      { id: '2', type: 'url', label: 'u1', url: 'http://example.com' },
      { id: '3', type: 'document', label: 'd1', fileId: 'file-1' },
    ]

    const out = await resolveAttachmentContext(attachments, lastUserMsg, 'tok')

    expect(out).toContain('the following 3 item(s)')
    const textIdx = out.indexOf('### Attached Text: "t1"')
    const urlIdx = out.indexOf('### Attached URL: http://example.com')
    const docIdx = out.indexOf('### Attached Document: "d1"')
    expect(textIdx).toBeGreaterThanOrEqual(0)
    expect(urlIdx).toBeGreaterThan(textIdx)   // order preserved
    expect(docIdx).toBeGreaterThan(urlIdx)    // order preserved
    // Block contents intact
    expect(out).toContain('hello world')
    expect(out).toContain('exa-page-body')
    expect(out).toContain('[Retrieved via Semantic Brain]')
    expect(out).toContain('**DocT**\nDocS')
  })

  it('isolates a failing attachment — others still resolve (per-item error isolation)', async () => {
    // Good url returns via Exa; bad url throws from BOTH Exa and raw fetch → catch.
    fetchUrlWithExa.mockImplementation(async (url: string) => {
      if (url === 'http://bad') throw new Error('exa down')
      return 'good-body'
    })
    fetchUrlContent.mockRejectedValue(new Error('raw fetch down'))

    const attachments: ChatAttachment[] = [
      { id: '1', type: 'url', label: 'good', url: 'http://good' },
      { id: '2', type: 'url', label: 'bad', url: 'http://bad' },
      { id: '3', type: 'text', label: 'txt', content: 'still here' },
    ]

    const out = await resolveAttachmentContext(attachments, lastUserMsg, 'tok')

    expect(out).toContain('the following 3 item(s)')   // all three still produce a block
    expect(out).toContain('good-body')                 // good one resolved
    expect(out).toContain('### Attached: "bad"\n\n[Failed to load content]') // isolated fallback
    expect(out).toContain('still here')                // later one unaffected
  })

  it('caps resolution at 5 attachments (.slice(0,5))', async () => {
    const attachments: ChatAttachment[] = Array.from({ length: 8 }, (_, i) => ({
      id: String(i),
      type: 'text' as const,
      label: `t${i}`,
      content: `body${i}`,
    }))

    const out = await resolveAttachmentContext(attachments, lastUserMsg, 'tok')

    expect(out).toContain('the following 5 item(s)')
    expect(out).toContain('body0')
    expect(out).toContain('body4')
    expect(out).not.toContain('body5') // 6th onward dropped
  })

  it('unmatched attachment shapes contribute no block (returns empty when all unmatched)', async () => {
    const attachments: ChatAttachment[] = [
      { id: '1', type: 'document', label: 'no-file' }, // document with no fileId
      { id: '2', type: 'url', label: 'no-url' },       // url with no url
    ]
    expect(await resolveAttachmentContext(attachments, lastUserMsg, 'tok')).toBe('')
  })
})
