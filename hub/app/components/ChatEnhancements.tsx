'use client'

import { useCallback, useRef, useState } from 'react'
import type { InterviewState, InterviewIntent, ActionSpec } from '@/types'

/* ── E4: Swipe-to-dismiss hook ── */
function useSwipeDismiss(onDismiss: () => void) {
  const startXRef = useRef<number | null>(null)
  const [offsetX, setOffsetX] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const THRESHOLD = 100

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    startXRef.current = e.touches[0].clientX
    setOffsetX(0)
  }, [])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (startXRef.current === null) return
    setOffsetX(e.touches[0].clientX - startXRef.current)
  }, [])

  const onTouchEnd = useCallback(() => {
    if (Math.abs(offsetX) > THRESHOLD) {
      setDismissed(true)
      setTimeout(onDismiss, 200)
    } else {
      setOffsetX(0)
    }
    startXRef.current = null
  }, [offsetX, onDismiss])

  const style: React.CSSProperties = {
    transform: dismissed
      ? `translateX(${offsetX > 0 ? '120%' : '-120%'})`
      : offsetX ? `translateX(${offsetX}px)` : undefined,
    transition: dismissed || !offsetX ? 'transform 0.2s ease-out, opacity 0.2s ease-out' : 'none',
    opacity: dismissed ? 0 : 1 - Math.abs(offsetX) / 400,
  }

  return { onTouchStart, onTouchMove, onTouchEnd, style }
}

/* ══════════════════════════════════════════════════════════════════════════════
   INTERVIEW BADGE
   Shows when Interview Mode is active — gold pulsing border, step progress
   ══════════════════════════════════════════════════════════════════════════════ */

const INTENT_LABELS: Record<InterviewIntent, string> = {
  create_task: 'Create Task',
  schedule_event: 'Schedule Event',
  send_communication: 'Send Communication',
  create_paperclip_issue: 'Create Paperclip Issue',
}

export function InterviewBadge({
  state,
  totalQuestions,
  onCancel,
}: {
  state: InterviewState
  totalQuestions: number
  onCancel: () => void
}) {
  const swipe = useSwipeDismiss(onCancel)

  if (!state.active || !state.intent) return null

  const intentLabel = INTENT_LABELS[state.intent]
  const stepDisplay = `Question ${Math.min(state.step + 1, totalQuestions)} of ${totalQuestions}`

  return (
    <div
      role="alert"
      aria-live="polite"
      className="interview-badge"
      onTouchStart={swipe.onTouchStart}
      onTouchMove={swipe.onTouchMove}
      onTouchEnd={swipe.onTouchEnd}
      style={swipe.style}
    >
      {/* Icon */}
      <span aria-hidden="true" className="interview-badge__icon">
        🎯
      </span>

      {/* Label + Step */}
      <div className="interview-badge__body">
        <div className="interview-badge__title">
          Interview Mode — {intentLabel}
        </div>
        <div className="interview-badge__step">
          {stepDisplay}
        </div>
      </div>

      {/* Cancel button */}
      <button
        onClick={onCancel}
        aria-label="Cancel interview mode"
        className="interview-badge__cancel"
      >
        ✕
      </button>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   CONTEXT INJECTION BANNER
   Shows when context is injected from a panel tap (progressive disclosure)
   ══════════════════════════════════════════════════════════════════════════════ */

export function ContextInjectionBanner({
  source,
  onDismiss,
}: {
  source: string
  onDismiss: () => void
}) {
  const swipe = useSwipeDismiss(onDismiss)

  return (
    <div
      role="status"
      aria-live="polite"
      className="context-banner"
      onTouchStart={swipe.onTouchStart}
      onTouchMove={swipe.onTouchMove}
      onTouchEnd={swipe.onTouchEnd}
      style={swipe.style}
    >
      {/* Icon */}
      <span aria-hidden="true" className="context-banner__icon">
        📌
      </span>

      {/* Source text */}
      <div className="context-banner__text">
        <span className="context-banner__label">Context:</span>{' '}
        {source}
      </div>

      {/* Dismiss */}
      <button
        onClick={onDismiss}
        aria-label="Dismiss context"
        className="context-banner__dismiss"
      >
        ✕
      </button>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   ACTION CONFIRM CARD
   Renders the structured action spec for user approval after interview
   ══════════════════════════════════════════════════════════════════════════════ */

const INTENT_DISPLAY_LABELS: Record<InterviewIntent, string> = {
  create_task: '📋 Create Task',
  schedule_event: '📅 Schedule Event',
  send_communication: '✉️ Send Communication',
  create_paperclip_issue: '🤖 Run Agent',
}

export function ActionConfirmCard({
  spec,
  onApprove,
  onEdit,
  onCancel,
}: {
  spec: ActionSpec
  onApprove: () => void
  onEdit: () => void
  onCancel: () => void
}) {
  const displayLabel = INTENT_DISPLAY_LABELS[spec.intent]

  // Nicely formatted detail key labels
  const formatKey = useCallback((key: string): string => {
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (l) => l.toUpperCase())
  }, [])

  return (
    <div
      role="region"
      aria-label="Action confirmation"
      className="card-glass action-confirm-card"
    >
      {/* Gold accent line on top */}
      <div aria-hidden="true" className="action-confirm-card__accent-line" />

      {/* Header */}
      <div className="action-confirm-card__header">
        {displayLabel}
      </div>

      {/* Details key-value pairs */}
      <div className="action-confirm-card__details">
        {Object.entries(spec.details).map(([key, value]) => (
          <div key={key} className="action-detail-row">
            <span className="action-detail-row__key">
              {formatKey(key)}
            </span>
            <span className="action-detail-row__value">
              {value}
            </span>
          </div>
        ))}
      </div>

      {/* Target systems */}
      <div className="action-confirm-card__systems">
        {spec.targetSystems.map((sys) => (
          <span key={sys} className="action-confirm-card__system-chip">
            {sys}
          </span>
        ))}
      </div>

      {/* Action buttons */}
      <div className="action-confirm-card__actions">
        {/* Approve */}
        <button
          onClick={onApprove}
          aria-label="Approve action"
          className="action-btn-approve"
        >
          ✓ Approve
        </button>

        {/* Edit */}
        <button
          onClick={onEdit}
          aria-label="Edit action details"
          className="action-btn-edit"
        >
          Edit
        </button>

        {/* Cancel */}
        <button
          onClick={onCancel}
          aria-label="Cancel action"
          className="action-btn-cancel"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
