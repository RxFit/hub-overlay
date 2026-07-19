import { useCallback, useEffect, useRef } from 'react'

/* ════════════════════════════════════════════════════════════════════════════
   useSwipePanels — single-finger drawer swipe + pinch-zoom guard (#29)

   The gesture logic is a PURE, typed state machine (`gestureReducer`) so every
   terminal transition is provable and unit-testable. The React hook is a thin
   adapter that feeds touch events into the reducer and applies the two allowed
   side effects:

     • open/close commands → the page's open-state setters (React state), which
       are the SOLE source of truth for backdrop + resting drawer position.
     • a live drag transform → ONE CSS custom property (`--drawer-drag-x`) written
       to the dragged panel via requestAnimationFrame, plus a `[data-dragging]`
       attribute the stylesheet keys off. The transform math is in CSS.

   Critically, this hook NEVER mutates the backdrop's inline display/opacity.
   Backdrop visibility is a pure function of `mobileLeftOpen || mobileRightOpen`
   rendered by React (see page.tsx), so a stranded inline style — the root cause
   of the stuck-`.mobile-backdrop` P0 — is structurally impossible.
   ════════════════════════════════════════════════════════════════════════════ */

export interface SwipePanelsProps {
  mobileLeftOpen: boolean
  mobileRightOpen: boolean
  handleClosePanels: () => void
  handleMobileTab: (tab: 'command' | 'execution' | 'chat') => void
  /** Fully disengage the drawer swipe gesture (e.g. while the Google Chat /
   *  Gmail overlay is open — horizontal strips there need the finger). */
  disabled?: boolean
}

// px of horizontal travel required before the direction lock even considers a
// gesture (below this it's a tap / jitter).
export const SWIPE_MOVE_THRESHOLD = 12
// horizontal must exceed vertical by this ratio to lock as a drawer swipe — a
// chat answer scrolls vertically in the same shell, so disambiguation is strict.
export const SWIPE_DIR_RATIO = 1.3
// px to commit an open/close on release.
export const SWIPE_COMMIT = 104
// live drag visuals only run on phone-width viewports (matches the resting CSS).
export const DRAG_MAX_WIDTH = 640

export type SwipeDir = 'left' | 'right'

export interface PanelOpenFlags {
  left: boolean
  right: boolean
}

/** Terminal transitions ask the page to flip open-state; nothing else. */
export type GestureCommand = 'none' | 'open-left' | 'open-right' | 'close'

/** Which panel to translate and by how many px during a live drag. */
export interface DragTransform {
  side: SwipeDir
  x: number
}

export type GestureState =
  | { phase: 'idle' }
  | { phase: 'tracking'; startX: number; startY: number }
  | { phase: 'dragging'; startX: number; startY: number; dir: SwipeDir }

export type GestureInput =
  | { type: 'start'; x: number; y: number; touches: number; blocked: boolean }
  | { type: 'move'; x: number; y: number; touches: number; screenW: number; open: PanelOpenFlags }
  | { type: 'end'; x: number; screenW: number; open: PanelOpenFlags }

export interface GestureResult {
  state: GestureState
  command: GestureCommand
  /** Active drag transform to paint, or null to clear all drag visuals. */
  drag: DragTransform | null
}

export const IDLE: GestureState = { phase: 'idle' }

/**
 * Pure translate math for a live drag — identical to the pre-refactor inline
 * transforms, just returned as data instead of written to `el.style`.
 */
export function computeDrag(
  dir: SwipeDir,
  dx: number,
  open: PanelOpenFlags,
  screenW: number,
): DragTransform | null {
  if (dir === 'right') {
    if (open.right) {
      // Closing the right panel — drag it away to the right.
      return { side: 'right', x: Math.max(0, dx) }
    }
    if (!open.left) {
      // Opening the left panel — drag it in from -100%.
      const progress = Math.min(dx / screenW, 1)
      return { side: 'left', x: -screenW + progress * screenW }
    }
    return null
  }
  // dir === 'left'
  if (open.left) {
    // Closing the left panel — drag it away to the left.
    return { side: 'left', x: Math.min(0, dx) }
  }
  if (!open.right) {
    // Opening the right panel — drag it in from +100%.
    const progress = Math.min(Math.abs(dx) / screenW, 1)
    return { side: 'right', x: screenW - progress * screenW }
  }
  return null
}

/**
 * The gesture state machine. Pure: `(state, input) → { state, command, drag }`.
 * By construction the only way open-state changes is a terminal `end` producing
 * a command, and every terminal transition returns `state: IDLE` with `drag:
 * null` — so no residual drag visual and no backdrop desync can survive it.
 */
export function gestureReducer(state: GestureState, input: GestureInput): GestureResult {
  switch (input.type) {
    case 'start': {
      // Multi-finger (pinch-zoom, #29) or a tap inside a chat interaction zone is
      // never a panel swipe — drop straight to idle so nothing tracks it.
      if (input.touches > 1 || input.blocked) {
        return { state: IDLE, command: 'none', drag: null }
      }
      return {
        state: { phase: 'tracking', startX: input.x, startY: input.y },
        command: 'none',
        drag: null,
      }
    }

    case 'move': {
      if (state.phase === 'idle') return { state, command: 'none', drag: null }
      // A second finger landed mid-swipe (pinch) — abort so the drawer snaps back
      // instead of jumping toward the new touch point.
      if (input.touches > 1) return { state: IDLE, command: 'none', drag: null }

      let next = state
      if (state.phase === 'tracking') {
        const dx = input.x - state.startX
        const dy = input.y - state.startY
        const adx = Math.abs(dx)
        const ady = Math.abs(dy)
        if (adx < SWIPE_MOVE_THRESHOLD && ady < SWIPE_MOVE_THRESHOLD) {
          return { state, command: 'none', drag: null } // not enough movement yet
        }
        if (ady >= adx) {
          // Vertical-dominant — it's a scroll. Stop tracking this gesture.
          return { state: IDLE, command: 'none', drag: null }
        }
        if (adx < ady * SWIPE_DIR_RATIO) {
          return { state, command: 'none', drag: null } // horizontal but not clearly so — wait
        }
        next = { phase: 'dragging', startX: state.startX, startY: state.startY, dir: dx > 0 ? 'right' : 'left' }
      }

      // next.phase === 'dragging' here
      if (next.phase !== 'dragging') return { state: next, command: 'none', drag: null }
      if (input.screenW > DRAG_MAX_WIDTH) {
        return { state: next, command: 'none', drag: null } // desktop/tablet — no live drag
      }
      const dx = input.x - next.startX
      return { state: next, command: 'none', drag: computeDrag(next.dir, dx, input.open, input.screenW) }
    }

    case 'end': {
      // Only a locked-in drag can commit; anything else (tap, scroll, pinch) is a
      // no-op that lands back at idle with zero residual.
      if (state.phase !== 'dragging' || input.screenW > DRAG_MAX_WIDTH) {
        return { state: IDLE, command: 'none', drag: null }
      }
      const dx = input.x - state.startX
      const committed = Math.abs(dx) > SWIPE_COMMIT
      const { left, right } = input.open
      let command: GestureCommand = 'none'
      if (state.dir === 'right') {
        if (right && committed) command = 'close'
        else if (!left && committed) command = 'open-left'
      } else {
        if (left && committed) command = 'close'
        else if (!right && committed) command = 'open-right'
      }
      return { state: IDLE, command, drag: null }
    }
  }
}

// Chat interaction zones where a horizontal drag must not be hijacked as a swipe.
const INTERACTION_ZONE_SELECTORS = [
  '.chat-suggestions',
  '.chat-input-area',
  '.quoted-reply-chip',
  '.doc-filter-tabs',
  '.section-row',
]

function isBlockedTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return INTERACTION_ZONE_SELECTORS.some(sel => el.closest(sel))
}

export function useSwipePanels({
  mobileLeftOpen,
  mobileRightOpen,
  handleClosePanels,
  handleMobileTab,
  disabled = false,
}: SwipePanelsProps) {
  const leftPanelRef = useRef<HTMLElement>(null)
  const rightPanelRef = useRef<HTMLElement>(null)

  const stateRef = useRef<GestureState>(IDLE)
  const rafRef = useRef<number | null>(null)
  const pendingDragRef = useRef<DragTransform | null>(null)

  // Write the live drag transform to the dragged panel via a single CSS var. The
  // stylesheet turns `--drawer-drag-x` + `[data-dragging]` into the transform,
  // so no imperative transform/display/opacity write happens here.
  const paintDrag = useCallback((drag: DragTransform | null) => {
    const left = leftPanelRef.current
    const right = rightPanelRef.current
    const clear = (el: HTMLElement | null) => {
      if (!el) return
      el.style.removeProperty('--drawer-drag-x')
      el.removeAttribute('data-dragging')
    }
    clear(left)
    clear(right)
    if (drag) {
      const el = drag.side === 'left' ? left : right
      if (el) {
        el.style.setProperty('--drawer-drag-x', `${drag.x}px`)
        el.setAttribute('data-dragging', 'true')
      }
    }
  }, [])

  // Coalesce move-driven paints to one per frame.
  const scheduleDrag = useCallback((drag: DragTransform | null) => {
    pendingDragRef.current = drag
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      paintDrag(pendingDragRef.current)
    })
  }, [paintDrag])

  // Immediately drop all drag visuals (release/cancel) so React's open-state and
  // the resting CSS transition take over the drawer position.
  const clearDrag = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    pendingDragRef.current = null
    paintDrag(null)
  }, [paintDrag])

  const runCommand = useCallback((command: GestureCommand) => {
    if (command === 'open-left') handleMobileTab('command')
    else if (command === 'open-right') handleMobileTab('execution')
    else if (command === 'close') handleClosePanels()
  }, [handleMobileTab, handleClosePanels])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (disabled) return
    const touch = e.touches[0]
    const result = gestureReducer(stateRef.current, {
      type: 'start',
      x: touch ? touch.clientX : 0,
      y: touch ? touch.clientY : 0,
      touches: e.touches.length,
      blocked: isBlockedTarget(e.target),
    })
    stateRef.current = result.state
    // A pinch that interrupts an in-progress drag lands here as a fresh
    // multi-touch start → idle; clear any drag visuals so it snaps back.
    if (result.state.phase === 'idle') clearDrag()
  }, [disabled, clearDrag])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (disabled) return
    const touch = e.touches[0]
    const result = gestureReducer(stateRef.current, {
      type: 'move',
      x: touch ? touch.clientX : 0,
      y: touch ? touch.clientY : 0,
      touches: e.touches.length,
      screenW: window.innerWidth,
      open: { left: mobileLeftOpen, right: mobileRightOpen },
    })
    stateRef.current = result.state
    if (result.state.phase === 'dragging') scheduleDrag(result.drag)
    else clearDrag()
  }, [disabled, mobileLeftOpen, mobileRightOpen, scheduleDrag, clearDrag])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (disabled) return
    const touch = e.changedTouches[0]
    const result = gestureReducer(stateRef.current, {
      type: 'end',
      x: touch ? touch.clientX : 0,
      screenW: window.innerWidth,
      open: { left: mobileLeftOpen, right: mobileRightOpen },
    })
    stateRef.current = result.state
    clearDrag()
    runCommand(result.command)
  }, [disabled, mobileLeftOpen, mobileRightOpen, clearDrag, runCommand])

  // Disabling mid-gesture (overlay opened under the finger) must drop any
  // in-flight tracking/drag so no residual visuals or stale state survive.
  useEffect(() => {
    if (disabled) {
      stateRef.current = IDLE
      clearDrag()
    }
  }, [disabled, clearDrag])

  // rAF cleanup on unmount.
  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
  }, [])

  return {
    leftPanelRef,
    rightPanelRef,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  }
}
