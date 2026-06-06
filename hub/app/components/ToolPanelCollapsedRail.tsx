'use client'

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
   edge of the screen. Tapping it switches to the tool panel view.
   ══════════════════════════════════════════════════════════════════════════════ */

interface MobileToolEdgeProps {
  activeSkill: ActiveSkill
  onTap: () => void
}

export function MobileToolEdge({ activeSkill, onTap }: MobileToolEdgeProps) {
  return (
    <button
      className="tool-edge-indicator"
      onClick={onTap}
      aria-label={`${activeSkill.name} is active — tap to view`}
      title="Tool panel active"
    >
      <div className="tool-edge-indicator__glow" aria-hidden="true" />
    </button>
  )
}
