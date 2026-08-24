// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useDeepAvailability, type DeepAvailability } from './useDeepAvailability'

// React 18 concurrent rendering requires an act environment flag.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * useDeepAvailability — the featured chips' honesty source (PR D).
 * Locks: the three rendered states (unknown → live/offline), the keep-last-
 * known-state behavior on transient failures, and that a disabled hook
 * never fetches (onboarding / signed-out).
 */

function renderHook(enabled: boolean) {
  const result: { current: DeepAvailability } = { current: undefined as unknown as DeepAvailability }
  const container = document.createElement('div')
  let root: Root

  function Probe() {
    result.current = useDeepAvailability(enabled)
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(Probe))
  })

  return { result, unmount: () => act(() => { root.unmount() }) }
}

const settle = () => act(async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
})

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useDeepAvailability', () => {
  it('starts unknown, then reports live from the availability read', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ available: true, reason: null }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(true)
    expect(result.current.available).toBeNull() // unknown, never falsely dead
    await settle()
    expect(result.current).toEqual({ available: true, reason: null })
    expect(fetchMock).toHaveBeenCalledWith('/api/deep-runs/availability')
    unmount()
  })

  it('reports offline with its reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ available: false, reason: 'no_worker' })))
    const { result, unmount } = renderHook(true)
    await settle()
    expect(result.current).toEqual({ available: false, reason: 'no_worker' })
    unmount()
  })

  it('keeps the last known state through a transient failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ available: true, reason: null }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(true)
    await settle()
    expect(result.current.available).toBe(true)
    fetchMock.mockRejectedValue(new Error('network'))
    await settle()
    expect(result.current.available).toBe(true) // blip ≠ offline
    unmount()
  })

  it('never fetches while disabled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = renderHook(false)
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
    unmount()
  })
})
