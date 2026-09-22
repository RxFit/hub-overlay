import { describe, it, expect, vi, afterEach } from 'vitest'
import { evaluateHits, isJevConfigured } from './jev'

const HIT = { vaultPath: 'Projects/Hub Overlay.md', headingPath: 'Hub Overlay', excerpt: 'text', similarity: 0.9 }

describe('JEV evaluator seam (default OFF, shadow-only, no network)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports disabled without JEV_API_KEY and never touches the network', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(isJevConfigured({})).toBe(false)
    expect(evaluateHits({ queryId: 'q', queryLength: 5, hits: [HIT] }, {})).toEqual({ status: 'disabled' })
    expect(evaluateHits({ queryId: 'q', queryLength: 5, hits: [HIT] }, { JEV_API_KEY: '   ' })).toEqual({ status: 'disabled' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('with a key it only shadows: counts hits, makes no call, and cannot alter them', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const hits = [HIT, { ...HIT, vaultPath: 'B.md' }]
    const before = JSON.stringify(hits)
    expect(evaluateHits({ queryId: 'q1', queryLength: 5, hits }, { JEV_API_KEY: 'k' })).toEqual({ status: 'shadow', queryId: 'q1', evaluated: 2 })
    expect(evaluateHits({ queryId: 'q2', queryLength: 5, hits: [] }, { JEV_API_KEY: 'k' })).toEqual({ status: 'skipped', reason: 'no hits to evaluate' })
    expect(JSON.stringify(hits)).toBe(before)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
