// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useStallDetector } from './useStallDetector'
import type { FeedItem } from '@/app/hooks/useHubData'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* ════════════════════════════════════════════════════════════════════════════
   useStallDetector (NS-11) — the amber/red stall thresholds that drive the
   feed's "this agent looks stuck" affordance. Fake timers pin the clock so the
   30/60-minute boundaries and the 5-minute poll re-evaluation are asserted
   exactly, not approximately.
   ════════════════════════════════════════════════════════════════════════════ */

const NOW = new Date('2026-07-08T12:00:00Z')
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000).toISOString()

function feedItem(id: string, type: string, timestamp: string): FeedItem {
  return { id, type, timestamp, source: 'paperclip', title: id, description: '' } as unknown as FeedItem
}

/** Minimal renderHook (no query provider needed — the hook is timer/state only). */
function renderStall(getArgs: () => Parameters<typeof useStallDetector>) {
  const result = { current: undefined as unknown as ReturnType<typeof useStallDetector> }
  const container = document.createElement('div')
  let root: Root
  function Probe() {
    result.current = useStallDetector(...getArgs())
    return null
  }
  act(() => {
    root = createRoot(container)
    root.render(createElement(Probe))
  })
  return { result, unmount: () => act(() => root.unmount()) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useStallDetector — threshold classification', () => {
  it('classifies in_progress items at the default 30/60-minute boundaries (>= is inclusive)', () => {
    const items = [
      feedItem('fresh', 'in_progress', minsAgo(29)),
      feedItem('amber-exact', 'in_progress', minsAgo(30)),
      feedItem('amber-mid', 'in_progress', minsAgo(45)),
      feedItem('red-exact', 'in_progress', minsAgo(60)),
      feedItem('red-old', 'in_progress', minsAgo(240)),
    ]
    const { result, unmount } = renderStall(() => [items])

    expect(result.current.stallMap.get('fresh')?.status).toBe('normal')
    expect(result.current.stallMap.get('amber-exact')?.status).toBe('amber')
    expect(result.current.stallMap.get('red-exact')?.status).toBe('red')
    expect(result.current.amberItems.map(s => s.itemId).sort()).toEqual(['amber-exact', 'amber-mid'])
    expect(result.current.redItems.map(s => s.itemId).sort()).toEqual(['red-exact', 'red-old'])
    expect(result.current.stalledItems).toHaveLength(4) // fresh is not "stalled"

    // stalledSinceMs reports how long the item has been sitting.
    expect(result.current.stallMap.get('red-old')?.stalledSinceMs).toBe(240 * 60 * 1000)
    expect(result.current.stallMap.get('fresh')?.stalledSinceMs).toBeUndefined()
    unmount()
  })

  it('only monitors in_progress items — other feed types never enter the map', () => {
    const items = [
      feedItem('done-old', 'completed', minsAgo(500)),
      feedItem('needs-you-old', 'needs_you', minsAgo(500)),
      feedItem('working', 'in_progress', minsAgo(90)),
    ]
    const { result, unmount } = renderStall(() => [items])
    expect(result.current.stallMap.size).toBe(1)
    expect(result.current.stallMap.get('working')?.status).toBe('red')
    unmount()
  })

  it('treats an unparseable timestamp as normal (never a false alarm)', () => {
    const items = [feedItem('garbage', 'in_progress', 'not-a-date')]
    const { result, unmount } = renderStall(() => [items])
    expect(result.current.stallMap.get('garbage')?.status).toBe('normal')
    expect(result.current.stalledItems).toHaveLength(0)
    unmount()
  })

  it('honors custom amber/red thresholds', () => {
    const items = [feedItem('x', 'in_progress', minsAgo(6))]
    const { result, unmount } = renderStall(() => [items, { amberMinutes: 5, redMinutes: 10 }])
    expect(result.current.stallMap.get('x')?.status).toBe('amber')
    unmount()
  })
})

describe('useStallDetector — polling', () => {
  it('re-evaluates on the poll interval so items degrade to amber/red as wall-clock time passes', () => {
    const items = [feedItem('aging', 'in_progress', minsAgo(25))]
    const { result, unmount } = renderStall(() => [items, { pollIntervalMs: 60_000 }])
    expect(result.current.stallMap.get('aging')?.status).toBe('normal')

    // +6 minutes of polls: the item is now 31 minutes old → amber.
    act(() => { vi.advanceTimersByTime(6 * 60_000) })
    expect(result.current.stallMap.get('aging')?.status).toBe('amber')

    // +30 more minutes: 61 minutes old → red.
    act(() => { vi.advanceTimersByTime(30 * 60_000) })
    expect(result.current.stallMap.get('aging')?.status).toBe('red')
    unmount()
  })

  it('clears its interval on unmount (no timers leak)', () => {
    const items = [feedItem('x', 'in_progress', minsAgo(1))]
    const { unmount } = renderStall(() => [items])
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
