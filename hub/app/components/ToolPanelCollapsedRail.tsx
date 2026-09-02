'use client'

import { useCallback, useRef } from 'react'
import type { ActiveSkill } from '@/types'

/* ══════════════════════════════════════════════════════════════════════════════
   TOOL PANEL COLLAPSED RAIL
   
   When the tool panel is collapsed, this thin vertical rail renders on the
   right edge with a pulsing champagne gold "LIVE" indicator. Clicking it
   re-expands the full tool panel.
   ══════════════════════════════════════════════════════════════════════════════ */

interface ToolPanelCollapsedRailProps {
  activeSkill: ActiveSkill
  onExpand: () => void
}

export function ToolPanelCollapsedRail({ activeSkill, onExpand }: ToolPanelCollapsedRailProps) {
  return (
    <button
      className="tool-rail"
      onClick={onExpand}
      aria-label={`Expand ${activeSkill.name} tool panel`}
      title={`${activeSkill.name} is active — click to expand`}
    >
      {/* Pulsing glow indicator */}
      <div className="tool-rail__pulse" aria-hidden="true" />

      {/* Tool info (rotated 90°) */}
      <div className="tool-rail__content">
        <span className="tool-rail__icon" aria-hidden="true">⚡</span>
        <span className="tool-rail__name">{activeSkill.name}</span>
        <span className="tool-rail__live">LIVE</span>
      </div>
    </button>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   MOBILE EDGE INDICATOR

   On mobile, when the tool is active but the panel is not visible (user is
   on the chat tab), a thin champagne gold pulsing bar appears on the right
   edge of the screen. Tapping it — or dragging it leftward, the gesture a
   right-edge handle invites — brings the tool panel back.
   ══════════════════════════════════════════════════════════════════════════════ */

interface MobileToolEdgeProps {
  activeSkill: ActiveSkill
  onTap: () => void
}

/** px of leftward travel that counts as "pull the panel in". */
export const EDGE_SWIPE_OPEN_PX = 24

export function MobileToolEdge({ activeSkill, onTap }: MobileToolEdgeProps) {
  const startXRef = useRef<number | null>(null)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    startXRef.current = e.touches[0]?.clientX ?? null
  }, [])

  /* A finger that moved never produces a click, so a swipe and a tap are
     mutually exclusive paths into the same idempotent open. */
  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    const startX = startXRef.current
    startXRef.current = null
    const endX = e.changedTouches[0]?.clientX
    if (startX == null || endX == null) return
    if (startX - endX >= EDGE_SWIPE_OPEN_PX) onTap()
  }, [onTap])

  return (
    <button
      className="tool-edge-indicator"
      onClick={onTap}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      aria-label={`${activeSkill.name} is active — tap to view`}
      title={`${activeSkill.name} panel — tap or swipe left to open`}
    >
      <div className="tool-edge-indicator__glow" aria-hidden="true" />
      <span className="tool-edge-indicator__label" aria-hidden="true">{activeSkill.name}</span>
    </button>
  )
}
