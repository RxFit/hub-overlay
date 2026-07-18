import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * lib/exa.ts — Exa web-search wrapper.
 *
 * The exa-js client is mocked; these tests lock the wrapper's contract:
 *  - result mapping (highlights joined ' ... ', falling back to raw text),
 *  - searchWeb RE-THROWING upstream failures (so the circuit breaker can
 *    trip and callers can distinguish failure from zero results),
 *  - fetchUrlWithExa RE-THROWING so callers can fall back to raw fetch,
 *  - lazy client init failing loudly when EXA_API_KEY is missing.
 */
const { searchMock, contentsMock, ctorMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  contentsMock: vi.fn(),
  ctorMock: vi.fn(),
}))

vi.mock('exa-js', () => ({
  default: class FakeExa {
    constructor(key: string) {
      ctorMock(key)
    }
    searchAndContents = searchMock
    getContents = contentsMock
  },
}))

import { searchWeb, fetchUrlWithExa } from './exa'

beforeEach(() => {
  vi.stubEnv('EXA_API_KEY', 'test-key')
  searchMock.mockReset()
  contentsMock.mockReset()
})

describe('searchWeb', () => {
  it('maps results, joining highlights with " ... " as the snippet', async () => {
    searchMock.mockResolvedValueOnce({
      results: [
        {
          title: 'Doc',
          url: 'https://example.com/a',
          publishedDate: '2026-01-01',
          text: 'full text',
          highlights: ['first hit', 'second hit'],
        },
      ],
    })

    const out = await searchWeb('query')
    expect(out).toEqual([
      {
        title: 'Doc',
        url: 'https://example.com/a',
        publishedDate: '2026-01-01',
        snippet: 'first hit ... second hit',
      },
    ])
  })

  it('falls back to the raw text when a result has no highlights', async () => {
    searchMock.mockResolvedValueOnce({
      results: [{ url: 'https://example.com/b', text: 'body text', highlights: [] }],
    })
    const out = await searchWeb('query')
    expect(out[0].snippet).toBe('body text')
  })

  it('passes numResults/useAutoprompt through with sane defaults', async () => {
    searchMock.mockResolvedValueOnce({ results: [] })
    await searchWeb('defaults')
    expect(searchMock).toHaveBeenCalledWith(
      'defaults',
      expect.objectContaining({ numResults: 5, useAutoprompt: true }),
    )

    searchMock.mockResolvedValueOnce({ results: [] })
    await searchWeb('custom', { numResults: 2, useAutoprompt: false })
    expect(searchMock).toHaveBeenLastCalledWith(
      'custom',
      expect.objectContaining({ numResults: 2, useAutoprompt: false }),
    )
  })

  it('RE-THROWS when the upstream search fails (breaker must see failures)', async () => {
    searchMock.mockRejectedValueOnce(new Error('exa is down'))
    await expect(searchWeb('query')).rejects.toThrow('exa is down')
  })

  it('passes the per-result text budget through (default 1000, override 3000)', async () => {
    searchMock.mockResolvedValueOnce({ results: [] })
    await searchWeb('defaults')
    expect(searchMock).toHaveBeenLastCalledWith(
      'defaults',
      expect.objectContaining({ text: { maxCharacters: 1000 } }),
    )

    searchMock.mockResolvedValueOnce({ results: [] })
    await searchWeb('rich', { maxCharacters: 3000 })
    expect(searchMock).toHaveBeenLastCalledWith(
      'rich',
      expect.objectContaining({ text: { maxCharacters: 3000 } }),
    )
  })
})

describe('fetchUrlWithExa', () => {
  it('returns the first result text', async () => {
    contentsMock.mockResolvedValueOnce({ results: [{ text: 'page content' }] })
    await expect(fetchUrlWithExa('https://example.com')).resolves.toBe('page content')
    expect(contentsMock).toHaveBeenCalledWith(['https://example.com'], { text: true })
  })

  it('RE-THROWS when Exa returns no content, so the caller can fall back', async () => {
    contentsMock.mockResolvedValueOnce({ results: [] })
    await expect(fetchUrlWithExa('https://example.com')).rejects.toThrow(
      'No content returned from Exa',
    )
  })

  it('re-throws upstream failures instead of swallowing them', async () => {
    contentsMock.mockRejectedValueOnce(new Error('502 from exa'))
    await expect(fetchUrlWithExa('https://example.com')).rejects.toThrow('502 from exa')
  })
})

describe('lazy client initialization', () => {
  it('fails loudly when EXA_API_KEY is missing (both paths propagate)', async () => {
    vi.resetModules()
    vi.stubEnv('EXA_API_KEY', '')
    const fresh = await import('./exa')
    // searchWeb now PROPAGATES the config error (breaker/callers must see is optional)…
    await expect(fresh.searchWeb('q')).rejects.toThrow('EXA_API_KEY not configured')
    // …but fetchUrlWithExa propagates it (callers must know to fall back).
    await expect(fresh.fetchUrlWithExa('https://example.com')).rejects.toThrow(
      'EXA_API_KEY not configured',
    )
    expect(searchMock).not.toHaveBeenCalled()
  })

  it('constructs the client once with the configured key', async () => {
    searchMock.mockResolvedValue({ results: [] })
    await searchWeb('one')
    await searchWeb('two')
    const callsWithTestKey = ctorMock.mock.calls.filter(([k]) => k === 'test-key')
    expect(callsWithTestKey.length).toBe(1)
  })
})
