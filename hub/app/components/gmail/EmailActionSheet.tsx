'use client'

import { useEffect, useRef, useState } from 'react'
import type { GmailThread } from '@/app/hooks/useGmailInbox'

/**
 * EmailActionSheet — the action menu for one email thread.
 *
 * Opened by long-pressing a row in the inbox list or tapping ⋯ in the reading
 * view. Renders as a bottom sheet (mobile-first; centered narrow sheet on
 * desktop) with ≥48px rows:
 *   Delete (→ Trash, two-tap confirm) · Save to Google Task · Discuss in AI chat
 *
 * Purely presentational — the actions themselves live in useGmailInbox
 * (optimistic trash, save-to-task) and the page-level chat injector (discuss).
 */

interface EmailActionSheetProps {
  thread: GmailThread
  busy: boolean
  onDelete: () => void
  onSaveTask: () => void
  /** Absent when the AI chat injector isn't wired (defensive) — row hidden. */
  onDiscuss?: () => void
  onClose: () => void
}

/* The synthetic click that trails a long-press lands 0–200ms after this sheet
 * mounts (the browser hit-tests at touchend, when the backdrop already covers
 * the pressed row). Ignore any click inside this window so the ghost click
 * can neither close the sheet nor fire an action the user never chose. */
const GHOST_CLICK_GRACE_MS = 300

export function EmailActionSheet({ thread, busy, onDelete, onSaveTask, onDiscuss, onClose }: EmailActionSheetProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)
  const mountedAtRef = useRef(Date.now())

  useEffect(() => {
    // Dialog focus contract: move focus in on open, restore it on close.
    const prevFocus = document.activeElement as HTMLElement | null
    sheetRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()

    // Capture-phase + stopPropagation so Escape closes ONLY this sheet — the
    // surrounding GoogleChatPanel's own window Escape listener (useModalA11y,
    // bubble phase) must not also fire and tear down the whole panel.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      prevFocus?.focus?.()
    }
  }, [onClose])

  const guarded = (fn: () => void) => () => {
    if (Date.now() - mountedAtRef.current < GHOST_CLICK_GRACE_MS) return
    fn()
  }

  // Keep Tab cycling inside the dialog (aria-modal alone doesn't trap focus).
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const focusables = Array.from(
      sheetRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || !sheetRef.current?.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const extractName = (fromStr: string) => {
    const match = fromStr.match(/^(.+?)\s*</)
    return match ? match[1].trim() : fromStr.split('@')[0]
  }

  return (
    <div className="gmail-sheet-backdrop" onClick={guarded(onClose)}>
      <div
        ref={sheetRef}
        className="gmail-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Actions for email from ${extractName(thread.from)}`}
        onClick={e => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div className="gmail-sheet__grab" aria-hidden="true" />
        <div className="gmail-sheet__header">
          <div className="gmail-sheet__from">{extractName(thread.from)}</div>
          <div className="gmail-sheet__subject">{thread.subject}</div>
        </div>

        {onDiscuss && (
          <button className="gmail-sheet__row" disabled={busy} onClick={guarded(onDiscuss)}>
            <span className="gmail-sheet__icon" aria-hidden="true">✦</span>
            Discuss in AI chat
          </button>
        )}

        <button className="gmail-sheet__row" disabled={busy} onClick={guarded(onSaveTask)}>
          <span className="gmail-sheet__icon" aria-hidden="true">☑</span>
          Save to Google Task
        </button>

        <button
          className={`gmail-sheet__row gmail-sheet__row--danger${confirmingDelete ? ' gmail-sheet__row--confirming' : ''}`}
          disabled={busy}
          onClick={guarded(() => (confirmingDelete ? onDelete() : setConfirmingDelete(true)))}
        >
          <span className="gmail-sheet__icon" aria-hidden="true">🗑</span>
          {confirmingDelete ? 'Tap again to confirm delete' : 'Delete (move to Trash)'}
        </button>

        <button className="gmail-sheet__row gmail-sheet__row--cancel" onClick={guarded(onClose)}>
          Cancel
        </button>
      </div>
    </div>
  )
}
