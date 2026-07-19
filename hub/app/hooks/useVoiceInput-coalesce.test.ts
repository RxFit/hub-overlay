// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useVoiceInput } from './useVoiceInput'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* ════════════════════════════════════════════════════════════════════════════
   useVoiceInput — frame-coalesced flush (the "mic freezes the app" fix).

   Regression lock: the browser speech engine fires onresult many times per
   second (and iOS Safari in bursts). Before the fix, each event did a full
   setInput + textarea reflow, re-rendering the whole page per event and
   freezing the UI mid-dictation. The hook now stashes the newest transcript
   and applies it at most ONCE per animation frame. These tests pin that a
   burst collapses to a single flush and that stop() never drops the final
   words. A controllable SpeechRecognition + a manual rAF queue make it exact.
   ════════════════════════════════════════════════════════════════════════════ */

type ResultEvent = { results: Array<{ 0: { transcript: string }; isFinal: boolean; length: number }> }

let active: FakeRecognition | null = null
let rafQueue: Array<(() => void) | null> = []

class FakeRecognition {
  continuous = false
  interimResults = false
  lang = ''
  onresult: ((e: ResultEvent) => void) | null = null
  onerror: ((e: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  start() { active = this }
  stop() { if (active === this) active = null; this.onend?.() }
  abort() { if (active === this) active = null }
}

function evt(segments: Array<[string, boolean]>): ResultEvent {
  return { results: segments.map(([transcript, isFinal]) => ({ 0: { transcript }, isFinal, length: 1 })) }
}

function renderVoice(setInput: (v: string) => void) {
  const result = { current: undefined as unknown as ReturnType<typeof useVoiceInput> }
  const container = document.createElement('div')
  let root: Root
  function Probe() {
    result.current = useVoiceInput({ getInput: () => '', setInput })
    return null
  }
  act(() => {
    root = createRoot(container)
    root.render(createElement(Probe))
  })
  return { result, unmount: () => act(() => root.unmount()) }
}

/** Run every queued animation frame (as the browser would on the next paint). */
function flushFrames() {
  const q = rafQueue
  rafQueue = []
  act(() => q.forEach(cb => cb?.()))
}

beforeEach(() => {
  active = null
  rafQueue = []
  ;(window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition
  ;(window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition
  // Deterministic rAF: capture callbacks so the test controls when frames run.
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => rafQueue.push(cb))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { if (id >= 1) rafQueue[id - 1] = null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).SpeechRecognition
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition
})

describe('useVoiceInput — frame-coalesced flush', () => {
  it('collapses a 50-event burst into a single deferred setInput carrying the last transcript', () => {
    const setInput = vi.fn()
    const { result, unmount } = renderVoice(setInput)
    act(() => result.current.start())

    act(() => {
      for (let i = 1; i <= 50; i++) active?.onresult?.(evt([[`word${i} `, false]]))
    })

    // Nothing applied synchronously, and the 50 events scheduled ONE frame.
    expect(setInput).not.toHaveBeenCalled()
    expect(rafQueue.filter(Boolean).length).toBe(1)

    flushFrames()

    // Exactly one flush, carrying only the newest transcript.
    expect(setInput).toHaveBeenCalledTimes(1)
    expect(setInput).toHaveBeenLastCalledWith('word50')
    unmount()
  })

  it('stop() flushes the pending transcript synchronously so the last words are never lost', () => {
    const setInput = vi.fn()
    const { result, unmount } = renderVoice(setInput)
    act(() => result.current.start())

    act(() => active?.onresult?.(evt([['final words', true]])))
    expect(setInput).not.toHaveBeenCalled() // deferred to the frame

    act(() => result.current.stop())
    expect(setInput).toHaveBeenCalledWith('final words') // applied immediately on stop
    // The queued frame was cancelled, so a later paint does not re-apply.
    setInput.mockClear()
    flushFrames()
    expect(setInput).not.toHaveBeenCalled()
    unmount()
  })
})
