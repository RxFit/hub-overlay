'use client'

export interface MobileControlBarProps {
  onOpenLeft: () => void
  onOpenRight: () => void
}

export function MobileControlBar({ onOpenLeft, onOpenRight }: MobileControlBarProps) {
  return (
    <div className="mobile-control-bar">
      <button
        className="mobile-control-btn"
        onClick={onOpenLeft}
        aria-label="Open Tasks"
      >
        <span style={{ color: 'var(--accent)', marginRight: '6px' }}>☰</span> Tasks
      </button>
      <button
        className="mobile-control-btn"
        onClick={onOpenRight}
        aria-label="Open Activity"
      >
        <span style={{ color: 'var(--accent)', marginRight: '6px' }}>⚡</span> Activity
      </button>
    </div>
  )
}
