// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  gestureReducer,
  computeDrag,
  IDLE,
  SWIPE_COMMIT,
  type GestureState,
  type GestureInput,
  type GestureCommand,
  type PanelOpenFlags,
} from './useSwipePanels'

/* ════════════════════════════════════════════════════════════════════════════
   Unit tests for the gesture state machine.

   The load-bearing invariant: the backdrop's visibility is a PURE function of
   the open flags (`left || right`) rendered by React, and the ONLY way the open
   flags change is a terminal `end` transition emitting a command. So after every
   terminal transition we assert:
     • the reducer is back at `idle` with `drag: null` (zero residual visual), and
     • applying the emitted command to the open flags keeps
       backdropVisible === (left || right) — i.e. the backdrop can never desync.
   ════════════════════════════════════════════════════════════════════════════ */

const PHONE_W = 390

/** Model of the page's open-state reducer (handleMobileTab / handleClosePanels). */
function applyCommand(open: PanelOpenFlags, command: GestureCommand): PanelOpenFlags {
  switch (command) {
    case 'open-left':
      return { left: true, right: false }
    case 'open-right':
      return { left: false, right: true }
    case 'close':
      return { left: false, right: false }
    default:
      return open
  }
}

/** React derives backdrop visibility from exactly this expression (page.tsx). */
const backdropVisible = (open: PanelOpenFlags) => open.left || open.right

/** Drive a sequence of inputs through the reducer, threading state. */
function drive(inputs: GestureInput[], start: GestureState = IDLE) {
  let state = start
  let command: GestureCommand = 'none'
  let lastDrag = null as ReturnType<typeof gestureReducer>['drag']
  for (const input of inputs) {
    const result = gestureReducer(state, input)
    state = result.state
    command = result.command
    lastDrag = result.drag
  }
  return { state, command, lastDrag }
}

/** Assert a terminal transition left no residue and the backdrop stays in sync. */
function assertConsistentTerminal(
  openBefore: PanelOpenFlags,
  command: GestureCommand,
  state: GestureState,
  drag: unknown,
) {
  expect(state).toEqual(IDLE)
  expect(drag).toBeNull()
  const openAfter = applyCommand(openBefore, command)
  expect(backdropVisible(openAfter)).toBe(openAfter.left || openAfter.right)
}

describe('gestureReducer — single-finger open', () => {
  it('opens the left panel on a committed rightward swipe from closed', () => {
    const open = { left: false, right: false }
    const { state, command, lastDrag } = drive([
      { type: 'start', x: 40, y: 420, touches: 1, blocked: false },
      { type: 'move', x: 90, y: 422, touches: 1, screenW: PHONE_W, open },
      { type: 'move', x: 200, y: 424, touches: 1, screenW: PHONE_W, open },
      { type: 'end', x: 300, screenW: PHONE_W, open },
    ])
    expect(command).toBe('open-left')
    assertConsistentTerminal(open, command, state, lastDrag)
  })

  it('opens the right panel on a committed leftward swipe from closed', () => {
    const open = { left: false, right: false }
    const { state, command, lastDrag } = drive([
      { type: 'start', x: 350, y: 420, touches: 1, blocked: false },
      { type: 'move', x: 300, y: 422, touches: 1, screenW: PHONE_W, open },
      { type: 'move', x: 200, y: 424, touches: 1, screenW: PHONE_W, open },
      { type: 'end', x: 100, screenW: PHONE_W, open },
    ])
    expect(command).toBe('open-right')
    assertConsistentTerminal(open, command, state, lastDrag)
  })
})

describe('gestureReducer — single-finger close', () => {
  it('closes the open left panel on a committed leftward swipe', () => {
    const open = { left: true, right: false }
    const { state, command, lastDrag } = drive([
      { type: 'start', x: 300, y: 420, touches: 1, blocked: false },
      { type: 'move', x: 250, y: 422, touches: 1, screenW: PHONE_W, open },
      { type: 'move', x: 150, y: 424, touches: 1, screenW: PHONE_W, open },
      { type: 'end', x: 100, screenW: PHONE_W, open },
    ])
    expect(command).toBe('close')
    assertConsistentTerminal(open, command, state, lastDrag)
  })

  it('closes the open right panel on a committed rightward swipe', () => {
    const open = { left: false, right: true }
    const { state, command, lastDrag } = drive([
      { type: 'start', x: 40, y: 420, touches: 1, blocked: false },
      { type: 'move', x: 100, y: 422, touches: 1, screenW: PHONE_W, open },
      { type: 'move', x: 200, y: 424, touches: 1, screenW: PHONE_W, open },
      { type: 'end', x: 300, screenW: PHONE_W, open },
    ])
    expect(command).toBe('close')
    assertConsistentTerminal(open, command, state, lastDrag)
  })
})

describe('gestureReducer — below-threshold cancel', () => {
  it('does not commit when the horizontal travel is under SWIPE_COMMIT', () => {
    const open = { left: false, right: false }
    const shortEnd = 40 + (SWIPE_COMMIT - 10) // locks direction but stays under commit
    const { state, command, lastDrag } = drive([
      { type: 'start', x: 40, y: 420, touches: 1, blocked: false },
      { type: 'move', x: 70, y: 422, touches: 1, screenW: PHONE_W, open }, // locks right
      { type: 'end', x: shortEnd, screenW: PHONE_W, open },
    ])
    expect(command).toBe('none')
    assertConsistentTerminal(open, command, state, lastDrag)
  })
})

describe('gestureReducer — direction lock (vertical scroll must not drag)', () => {
  it('drops to idle and never commits on a vertical-dominant move', () => {
    const open = { left: false, right: false }
    const { state, command, lastDrag } = drive([
      { type: 'start', x: 200, y: 100, touches: 1, blocked: false },
      { type: 'move', x: 206, y: 260, touches: 1, screenW: PHONE_W, open }, // ady >> adx → scroll
      { type: 'move', x: 260, y: 400, touches: 1, screenW: PHONE_W, open }, // ignored (already idle)
      { type: 'end', x: 260, screenW: PHONE_W, open },
    ])
    expect(command).toBe('none')
    // After the vertical sample the machine is already idle mid-gesture.
    assertConsistentTerminal(open, command, state, lastDrag)
  })

  it('waits (no lock) on a near-diagonal move that is not clearly horizontal', () => {
    const open = { left: false, right: false }
    // adx=30, ady=25 → adx (30) < ady*1.3 (32.5) → stay tracking, no drag yet.
    const result = gestureReducer(
      { phase: 'tracking', startX: 200, startY: 200 },
      { type: 'move', x: 230, y: 225, touches: 1, screenW: PHONE_W, open },
    )
    expect(result.state.phase).toBe('tracking')
    expect(result.drag).toBeNull()
    expect(result.command).toBe('none')
  })
})

describe('gestureReducer — multi-touch cancel (#29 pinch-zoom guard)', () => {
  it('never tracks a gesture that starts with two fingers', () => {
    const open = { left: false, right: false }
    const { state, command, lastDrag } = drive([
      { type: 'start', x: 40, y: 420, touches: 2, blocked: false },
      { type: 'move', x: 300, y: 420, touches: 2, screenW: PHONE_W, open },
      { type: 'end', x: 300, screenW: PHONE_W, open },
    ])
    expect(command).toBe('none')
    assertConsistentTerminal(open, command, state, lastDrag)
  })

  it('aborts an in-progress drag when a second finger lands mid-swipe', () => {
    const open = { left: false, right: false }
    const { state, command, lastDrag } = drive([
      { type: 'start', x: 40, y: 420, touches: 1, blocked: false },
      { type: 'move', x: 120, y: 422, touches: 1, screenW: PHONE_W, open }, // locked, dragging
      { type: 'move', x: 200, y: 422, touches: 2, screenW: PHONE_W, open }, // pinch → abort
      { type: 'end', x: 300, screenW: PHONE_W, open },
    ])
    expect(command).toBe('none')
    assertConsistentTerminal(open, command, state, lastDrag)
  })
})

describe('gestureReducer — interaction-zone + guards', () => {
  it('does not track when the touch starts in a blocked interaction zone', () => {
    const result = gestureReducer(IDLE, {
      type: 'start',
      x: 40,
      y: 420,
      touches: 1,
      blocked: true,
    })
    expect(result.state).toEqual(IDLE)
  })

  it('ignores moves that arrive with no active gesture', () => {
    const open = { left: false, right: false }
    const result = gestureReducer(IDLE, {
      type: 'move',
      x: 100,
      y: 100,
      touches: 1,
      screenW: PHONE_W,
      open,
    })
    expect(result.state).toEqual(IDLE)
    expect(result.drag).toBeNull()
  })

  it('does not paint a live drag on desktop widths', () => {
    const open = { left: false, right: false }
    const { lastDrag, state } = drive([
      { type: 'start', x: 40, y: 420, touches: 1, blocked: false },
      { type: 'move', x: 200, y: 421, touches: 1, screenW: 1440, open },
    ])
    expect(state.phase).toBe('dragging') // direction still locks
    expect(lastDrag).toBeNull() // but no transform painted
  })

  it('does not commit on desktop even after a locked drag', () => {
    const open = { left: false, right: false }
    const { command, state, lastDrag } = drive([
      { type: 'start', x: 40, y: 420, touches: 1, blocked: false },
      { type: 'move', x: 200, y: 421, touches: 1, screenW: 1440, open },
      { type: 'end', x: 320, screenW: 1440, open },
    ])
    expect(command).toBe('none')
    assertConsistentTerminal(open, command, state, lastDrag)
  })
})

describe('computeDrag — transform math matches the pre-refactor inline values', () => {
  const W = 400

  it('opening left: drags in from -100%', () => {
    // progress = dx/W; x = -W + progress*W
    expect(computeDrag('right', 0, { left: false, right: false }, W)).toEqual({ side: 'left', x: -400 })
    expect(computeDrag('right', 200, { left: false, right: false }, W)).toEqual({ side: 'left', x: -200 })
    expect(computeDrag('right', 800, { left: false, right: false }, W)).toEqual({ side: 'left', x: 0 }) // clamped
  })

  it('closing right: drags away to the right, clamped at 0', () => {
    expect(computeDrag('right', 120, { left: false, right: true }, W)).toEqual({ side: 'right', x: 120 })
    expect(computeDrag('right', -50, { left: false, right: true }, W)).toEqual({ side: 'right', x: 0 })
  })

  it('opening right: drags in from +100%', () => {
    expect(computeDrag('left', -200, { left: false, right: false }, W)).toEqual({ side: 'right', x: 200 })
    expect(computeDrag('left', -800, { left: false, right: false }, W)).toEqual({ side: 'right', x: 0 }) // clamped
  })

  it('closing left: drags away to the left, clamped at 0', () => {
    expect(computeDrag('left', -120, { left: true, right: false }, W)).toEqual({ side: 'left', x: -120 })
    expect(computeDrag('left', 50, { left: true, right: false }, W)).toEqual({ side: 'left', x: 0 })
  })

  it('returns null when the swipe would fight an already-open opposite panel', () => {
    expect(computeDrag('right', 100, { left: true, right: false }, W)).toBeNull()
    expect(computeDrag('left', -100, { left: false, right: true }, W)).toBeNull()
  })
})

/* ════════════════════════════════════════════════════════════════════════════
   Hook-level `disabled` guard — with the Google Chat / Gmail overlay open,
   drawer swipes must be fully disengaged (horizontal strips there own the
   finger). Drives the real hook through a throwaway component (no
   @testing-library dependency) and asserts a full commit-distance swipe emits
   NO open/close command while disabled, and still works when enabled.
   ════════════════════════════════════════════════════════════════════════════ */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import { useSwipePanels } from './useSwipePanels'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function renderSwipeHook(disabled: boolean) {
  const handleMobileTab = vi.fn()
  const handleClosePanels = vi.fn()
  const result: { current: ReturnType<typeof useSwipePanels> } = {
    current: undefined as unknown as ReturnType<typeof useSwipePanels>,
  }
  const container = document.createElement('div')
  let root: Root
  function Probe() {
    result.current = useSwipePanels({
      mobileLeftOpen: false,
      mobileRightOpen: false,
      handleClosePanels,
      handleMobileTab,
      disabled,
    })
    return null
  }
  act(() => {
    root = createRoot(container)
    root.render(createElement(Probe))
  })
  return { result, handleMobileTab, handleClosePanels, unmount: () => act(() => root.unmount()) }
}

const touchEvt = (x: number, y: number) => ({
  touches: [{ clientX: x, clientY: y }],
  changedTouches: [{ clientX: x, clientY: y }],
  target: document.body,
}) as unknown as React.TouchEvent

describe('useSwipePanels — disabled while the chat/Gmail overlay is open', () => {
  const realInnerWidth = window.innerWidth
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: PHONE_W, configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: realInnerWidth, configurable: true })
  })

  function fullLeftSwipe(h: ReturnType<typeof renderSwipeHook>) {
    act(() => {
      h.result.current.handleTouchStart(touchEvt(320, 200))
      h.result.current.handleTouchMove(touchEvt(150, 200))
      h.result.current.handleTouchEnd(touchEvt(120, 200))
    })
  }

  it('a commit-distance swipe emits no command when disabled', () => {
    const h = renderSwipeHook(true)
    fullLeftSwipe(h)
    expect(h.handleMobileTab).not.toHaveBeenCalled()
    expect(h.handleClosePanels).not.toHaveBeenCalled()
    h.unmount()
  })

  it('the same swipe opens the right panel when enabled (control)', () => {
    const h = renderSwipeHook(false)
    fullLeftSwipe(h)
    expect(h.handleMobileTab).toHaveBeenCalledWith('execution')
    h.unmount()
  })
})
