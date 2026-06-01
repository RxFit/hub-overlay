'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import type { SpaceMember } from '@/app/hooks/useGoogleChat'

interface MentionPickerProps {
  members: SpaceMember[]
  filter: string
  onSelect: (member: SpaceMember) => void
  onClose: () => void
  /** Position relative to the composer */
  anchorRect?: DOMRect | null
}

export function MentionPicker({
  members,
  filter,
  onSelect,
  onClose,
  anchorRect,
}: MentionPickerProps) {
  const [highlightIndex, setHighlightIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Filter members by the typed text after @
  const filtered = members.filter(m => {
    const q = filter.toLowerCase()
    if (!q) return true
    return (
      m.displayName.toLowerCase().includes(q) ||
      (m.email?.toLowerCase().includes(q) ?? false)
    )
  }).slice(0, 6) // Max 6 results

  // Reset highlight when filter changes
  useEffect(() => {
    setHighlightIndex(0)
  }, [filter])

  // Keyboard navigation (attached to document, since textarea has focus)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightIndex(prev => Math.min(prev + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightIndex(prev => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (filtered[highlightIndex]) {
          onSelect(filtered[highlightIndex])
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', handler, true) // capture phase
    return () => document.removeEventListener('keydown', handler, true)
  }, [filtered, highlightIndex, onSelect, onClose])

  // Scroll highlighted item into view
  useEffect(() => {
    const el = listRef.current?.children[highlightIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  if (filtered.length === 0) return null

  // Position above the composer
  const style: React.CSSProperties = anchorRect
    ? {
        position: 'fixed',
        bottom: `calc(100vh - ${anchorRect.top}px + 4px)`,
        left: `${anchorRect.left}px`,
        maxWidth: `${Math.min(anchorRect.width, 320)}px`,
      }
    : {}

  return (
    <div
      className="mention-picker"
      role="listbox"
      aria-label="Mention a user"
      style={style}
    >
      <div className="mention-picker__header">
        <span className="mention-picker__label">Mention someone</span>
      </div>
      <div ref={listRef} className="mention-picker__list">
        {filtered.map((member, i) => {
          const initials = member.displayName
            .split(' ')
            .map(w => w[0])
            .slice(0, 2)
            .join('')
            .toUpperCase()

          return (
            <button
              key={member.name}
              role="option"
              aria-selected={i === highlightIndex}
              className={`mention-picker__item${i === highlightIndex ? ' mention-picker__item--active' : ''}`}
              onClick={() => onSelect(member)}
              onMouseEnter={() => setHighlightIndex(i)}
            >
              <span className="mention-picker__avatar" aria-hidden="true">
                {initials}
              </span>
              <span className="mention-picker__info">
                <span className="mention-picker__name">{member.displayName}</span>
                {member.email && (
                  <span className="mention-picker__email">{member.email}</span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Hook to detect @ trigger in a textarea value.
 * Returns the current mention filter text and the trigger state.
 */
export function useMentionTrigger(value: string, cursorPos: number) {
  // Walk backwards from cursor to find the last @ that isn't preceded by a non-space char
  const textBeforeCursor = value.slice(0, cursorPos)
  const atIndex = textBeforeCursor.lastIndexOf('@')

  if (atIndex === -1) return { active: false, filter: '', atIndex: -1 }

  // The @ must be at start of string or preceded by whitespace
  if (atIndex > 0 && !/\s/.test(textBeforeCursor[atIndex - 1])) {
    return { active: false, filter: '', atIndex: -1 }
  }

  const filter = textBeforeCursor.slice(atIndex + 1)

  // Don't activate if there's a space in the filter (means mention was completed or abandoned)
  // Allow spaces in names though — only bail if filter is very long
  if (filter.length > 30) {
    return { active: false, filter: '', atIndex: -1 }
  }

  return { active: true, filter, atIndex }
}
