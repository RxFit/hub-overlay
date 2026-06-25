'use client'

import { useEffect, RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Accessibility behavior for an always-rendered-when-open modal dialog:
 *  - captures the trigger element and restores focus to it on close/unmount
 *  - moves focus into the dialog on open (first focusable, or the dialog itself)
 *  - Escape closes
 *  - Tab is trapped within the dialog (wraps first <-> last)
 *
 * Mount this hook in a component that is only rendered while the dialog is open
 * (both call sites already gate rendering behind `showCreateModal` / `deleteConfirm`).
 */
export function useModalA11y(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const trigger = (document.activeElement as HTMLElement) ?? null

    // Move focus in on the next frame (after the open transition applies).
    const raf = requestAnimationFrame(() => {
      const focusable = dialog.querySelectorAll<HTMLElement>(FOCUSABLE)
      ;(focusable[0] ?? dialog).focus()
    })

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusable = dialog.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown)
      // Restore focus to the element that opened the dialog.
      trigger?.focus()
    }
  // onClose is stable per render of the gated component; including it is safe.
  }, [dialogRef, onClose])
}
